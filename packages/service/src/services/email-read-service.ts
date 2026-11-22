/**
 * The read side of the mailbox: list the merged sent/inbound timeline, read one message,
 * and mint a presigned download URL for one attachment. Injectable (repo + presigner + body
 * store + clock) so every branch is testable without AWS, and so
 * #13's MCP read tools can reuse this exact service — the REST routes are thin adapters,
 * mirroring how #6's send route and #7's MCP tool share one {@link EmailService}.
 *
 * Bodies: a message's decoded body is stored when it is ingested or sent — inline in the row,
 * or in S3 for a large one — so opening it is a row read, never a raw-MIME parse. INBOUND mail
 * is still gated on the stored verdicts (fail-closed via `decideExposure`): only an exposable
 * message ever has a stored body, and a quarantined one yields none. HTML is returned RAW as
 * data — the client owns safe rendering (#12). Every readable row has a stored body (rows from
 * before bodies were stored were backfilled once per deployment; see PR #89).
 */
import {
  ATTACHMENT_URL_TTL_SECONDS,
  type AttachmentDownloadResponse,
  type DeliveryEvent,
  type EmailAttachmentInfo,
  type EmailDetail,
  type EmailListFilter,
  type EmailListFilters,
  type EmailListItem,
  LIST_FILTER_SCAN_ROWS,
  type ListEmailsResponse,
  MAX_EMAIL_RESPONSE_BYTES,
  MAX_READ_BODY_BYTES,
  type RawEmailDownloadResponse,
  SERVICE_ATTACHMENT_URL_TTL_SECONDS,
  type ServiceEmailAttachment,
  type ServiceEmailDetail,
} from '@freemail/shared';
import { type EmailsDao, FAILED_PARTITION, type EmailSummary, type GetEmailOutput, type InboundAttachmentDescriptor } from '../data/emails-dao.js';
import { INBOUND_RAW_RETENTION_DAYS } from '@freemail/shared/storage';
import type { AttachmentPresigner } from '../facades/s3-attachment-presigner.js';
import type { MailBodyContent, MailBodyStore } from '../facades/s3-mail-body-store.js';
import { decideExposure } from '../utils/verdicts.js';
import { fitBodyToBudget } from '../utils/body-budget.js';
import { contentDispositionForDownload } from '../utils/content-disposition.js';
import { decodeEmailRef, encodeEmailRef } from '../utils/email-ref.js';
import { emailErrors } from '../utils/errors.js';
import { listEmailsPage, pageQuery, type MergeQuery, type MergeQueryResult } from '../utils/list-merge.js';
import { hasTextFilters, matchesListFilters, sortKeyBounds } from '../utils/list-filter.js';
import { getLogger } from '../utils/logger.js';
import { loadEmailBody } from './email-body-storage.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

export interface EmailReadServiceDeps {
  readonly emailsDao: EmailsDao;
  readonly presigner: AttachmentPresigner;
  /**
   * Presigns the originals of Errors-folder messages, which live in the quarantine bucket.
   * Absent (the MCP server, which has no original-download tool), those are not offered.
   */
  readonly quarantinePresigner?: AttachmentPresigner;
  /** Reads bodies stored outside the row (`bodies/...`). */
  readonly bodies: MailBodyStore;
  readonly now?: () => Date;
}

export interface ListEmailsServiceRequest {
  readonly direction?: EmailListFilter;
  readonly limit: number;
  readonly cursor?: string;
  /** Text and date filters; absent → the whole folder. */
  readonly filters?: EmailListFilters;
}

const logger = getLogger('EmailReadService');

/** At most this many attachments are presigned at once. */
const PRESIGN_CONCURRENCY = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows per list-index read while scanning for filter matches. */
const FILTER_BATCH_ROWS = 200;

function refForRow(row: Pick<EmailSummary, 'pk' | 'sk'>): { pk: string; sk: string } {
  return {
    pk: row.pk,
    sk: row.sk,
  };
}

export interface GetEmailServiceRequest {
  /** The opaque message handle minted from `{ pk, sk }` — never a client-supplied key. */
  readonly handle: string;
}

export type GetEmailServiceResponse = EmailDetail;

/** The same handle as {@link GetEmailServiceRequest}. */
export type GetEmailWithDownloadUrlsServiceRequest = GetEmailServiceRequest;

export interface GetAttachmentUrlServiceRequest {
  readonly handle: string;
  /** The attachment's stable per-message id (a MIME part index, or `link-<n>`). */
  readonly attachmentId: string;
}

export interface GetRawUrlServiceRequest {
  readonly handle: string;
}

export class EmailReadService {
  private readonly emailsDao: EmailsDao;
  private readonly presigner: AttachmentPresigner;
  private readonly quarantinePresigner: AttachmentPresigner | undefined;
  private readonly bodies: MailBodyStore;
  private readonly now: () => Date;

  constructor(deps: EmailReadServiceDeps) {
    this.emailsDao = deps.emailsDao;
    this.presigner = deps.presigner;
    this.quarantinePresigner = deps.quarantinePresigner;
    this.bodies = deps.bodies;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * List the merged (or direction-filtered) timeline, newest-first, one opaque-cursor page. A
   * date range narrows the query itself; text filters make each folder scan for matches (see
   * {@link scanForMatches}).
   */
  async listEmails(request: ListEmailsServiceRequest): Promise<ListEmailsResponse> {
    const filters = request.filters;
    const bounds = sortKeyBounds(filters);
    const query: MergeQuery =
      filters !== undefined && hasTextFilters(filters)
        ? (direction, opts) => this.scanForMatches(direction, opts, filters, bounds)
        : pageQuery(async (direction, opts) => (await this.emailsDao.listEmailSummaries({ direction, ...opts, ...bounds })).emails);
    const page = await listEmailsPage({
      query,
      ...(request.direction ? { direction: request.direction } : {}),
      limit: request.limit,
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    return {
      emails: page.rows.map((row) => this.toListItem(row)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * One folder's matches for a filtered page: read list-index rows newest-first in batches and
   * keep those that match, stopping at `limit` matches, at the folder's end, or after
   * {@link LIST_FILTER_SCAN_ROWS} rows — so a page costs at most that many small reads per
   * folder however rare the matches are, and says how far it got.
   */
  private async scanForMatches(
    direction: EmailListFilter,
    opts: { readonly limit: number; readonly afterSk?: string },
    filters: EmailListFilters,
    bounds: { readonly minSk?: string; readonly maxSk?: string },
  ): Promise<MergeQueryResult> {
    const matches: EmailSummary[] = [];
    let afterSk = opts.afterSk;
    let scanned = 0;
    let scannedToSk: string | undefined;
    while (scanned < LIST_FILTER_SCAN_ROWS) {
      const batchSize = Math.min(FILTER_BATCH_ROWS, LIST_FILTER_SCAN_ROWS - scanned);
      const batch = (await this.emailsDao.listEmailSummaries({ direction, limit: batchSize, afterSk, ...bounds })).emails;
      for (const row of batch) {
        scanned += 1;
        scannedToSk = row.sk;
        if (matchesListFilters(row, filters)) {
          matches.push(row);
          if (matches.length === opts.limit) {
            return { rows: matches, exhausted: false, scannedToSk };
          }
        }
      }
      if (batch.length < batchSize) {
        return { rows: matches, exhausted: true, ...(scannedToSk ? { scannedToSk } : {}) };
      }
      afterSk = scannedToSk;
    }
    return { rows: matches, exhausted: false, ...(scannedToSk ? { scannedToSk } : {}) };
  }

  /** Read one message. Received + exposable → body materialized; otherwise envelope-only. */
  async getEmail(request: GetEmailServiceRequest): Promise<GetEmailServiceResponse> {
    return this.detailFor(await this.loadRow(request.handle), request.handle);
  }

  private async detailFor(row: GetEmailOutput, handle: string): Promise<EmailDetail> {
    // Size the envelope first so the body budget accounts for the WHOLE response, not just
    // the body — the combined serialized bytes must stay under the Lambda response limit.
    const envelopeBytes = Buffer.byteLength(JSON.stringify(this.toDetail(row, handle, {})), 'utf8');
    const body = await this.materializeBody(row, envelopeBytes);
    return this.toDetail(row, handle, body);
  }

  /**
   * Mint a presigned download URL for one attachment. Only descriptors actually on the row
   * are addressable — a quarantined/virus/parse-failed message has none — so any other id
   * resolves to nothing → 404, never a guessable key. The raw S3 key is used server-side only.
   */
  async getAttachmentUrl(request: GetAttachmentUrlServiceRequest): Promise<AttachmentDownloadResponse> {
    const row = await this.loadRow(request.handle);
    const descriptor = rowAttachments(row).find((a) => a.id === request.attachmentId);
    if (!descriptor) {
      throw emailErrors.notFound('No such attachment.');
    }
    return this.presignAttachment(descriptor, ATTACHMENT_URL_TTL_SECONDS);
  }

  /**
   * The detail for a backend service (`GET /api/emails/{id}`): `getEmail` without the `.eml`
   * fields, with a presigned download URL on every attachment. The URLs last
   * SERVICE_ATTACHMENT_URL_TTL_SECONDS, long enough to fetch several large files in turn.
   */
  async getEmailWithDownloadUrls(request: GetEmailWithDownloadUrlsServiceRequest): Promise<ServiceEmailDetail> {
    const row = await this.loadRow(request.handle);
    const detail = await this.detailFor(row, request.handle);
    const descriptors = rowAttachments(row);
    const attachments = await mapWithConcurrency(detail.attachments, PRESIGN_CONCURRENCY, async (info): Promise<ServiceEmailAttachment> => {
      const descriptor = descriptors.find((a) => a.id === info.id);
      if (!descriptor) {
        throw new Error(`Attachment ${info.id} is listed but has no stored descriptor.`);
      }
      const link = await this.presignAttachment(descriptor, SERVICE_ATTACHMENT_URL_TTL_SECONDS);
      return { ...info, downloadUrl: link.url, downloadUrlExpiresAt: link.expiresAt };
    });
    const typed: ServiceEmailDetail = { ...detail, attachments };
    // No `.eml` route under /api, so its fields don't belong in the response. A test pins the
    // exact keys, so a field added to the web detail can't leak into this contract unnoticed.
    const result: Record<string, unknown> = { ...typed };
    delete result.rawAvailable;
    delete result.rawSuspicious;
    return result as unknown as ServiceEmailDetail;
  }

  /** A presigned GET that always downloads (never renders inline), whatever the object's metadata. */
  private async presignAttachment(descriptor: { readonly s3Key: string; readonly filename: string }, ttlSeconds: number): Promise<AttachmentDownloadResponse> {
    const url = await this.presigner.presign({
      key: descriptor.s3Key,
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload(descriptor.filename),
      expiresInSeconds: ttlSeconds,
    });
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
    return { url, expiresAt };
  }

  /**
   * Mint a presigned URL that downloads a message's original raw MIME as `<subject>.eml`. Only
   * a message whose detail reports `rawAvailable` resolves; anything else is a 404 (a received
   * message that didn't pass the virus scan or has aged out, a sent row without an archive).
   * An Errors-folder original comes from the quarantine bucket, flagged `rawSuspicious` on the
   * detail when it lacks a virus `PASS`. The S3 key is used server-side only.
   */
  async getRawUrl(request: GetRawUrlServiceRequest): Promise<RawEmailDownloadResponse> {
    const row = await this.loadRow(request.handle);
    const original = this.rawDownload(row);
    if (original === undefined) {
      throw emailErrors.notFound('The original message is not available.');
    }
    const url = await original.presigner.presign({
      key: original.key,
      // Forced download, like attachments: the raw MIME is never served as a renderable type.
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload(emlFilename(row.subject)),
      expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    });
    const expiresAt = new Date(this.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000).toISOString();
    return { url, expiresAt };
  }

  private async loadRow(handle: string): Promise<GetEmailOutput> {
    const ref = decodeEmailRef(handle);
    const row = await this.emailsDao.getEmail(ref);
    if (!row) {
      throw emailErrors.notFound('No such message.');
    }
    return row;
  }

  /** The body to return for a message; `{}` when it is not exposable or has none. */
  private async materializeBody(row: GetEmailOutput, envelopeBytes: number): Promise<{ text?: string; html?: string; bodyTruncated?: boolean }> {
    if (row.direction === 'inbound') {
      // Gate on the STORED verdicts first — a non-exposable row never yields a body, whatever
      // it carries (ingest stores none for one, so this is defense in depth).
      const exposure = decideExposure({ spamVerdict: row.spamVerdict, virusVerdict: row.virusVerdict }, row.parseStatus);
      if (!exposure.exposeContent) {
        return {};
      }
    }
    if (row.body !== undefined) {
      const content = await loadEmailBody(this.bodies, row.body);
      if (content === null) {
        // Stored bodies never expire, so a missing one is an integrity problem worth seeing.
        logger.warn(`Stored body for ${row.direction} message ${row.id} is missing or unreadable.`);
        return {};
      }
      return fitToResponse(content, envelopeBytes);
    }
    // Every row this code writes stores a body, and older rows were backfilled.
    logger.warn(`${row.direction} message ${row.id} has no stored body.`);
    return {};
  }

  private toListItem(row: EmailSummary): EmailListItem {
    const id = encodeEmailRef(refForRow(row));
    if (row.direction === 'sent') {
      return {
        id,
        direction: 'sent',
        from: row.from,
        to: row.to,
        cc: row.cc,
        subject: row.subject,
        date: row.sentAt,
        status: row.status,
        hasAttachments: row.attachmentCount > 0,
        attachmentCount: row.attachmentCount,
      };
    }
    return {
      id,
      direction: 'inbound',
      from: row.from,
      ...(row.fromName !== undefined ? { fromName: row.fromName } : {}),
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
      date: row.receivedAt,
      hasAttachments: row.hasAttachments,
      attachmentCount: row.attachmentCount,
      quarantined: row.quarantined,
      spamVerdict: row.spamVerdict,
      virusVerdict: row.virusVerdict,
      parseStatus: row.parseStatus,
      ...(row.pk === FAILED_PARTITION ? { failed: true } : {}),
    };
  }

  private toDetail(row: GetEmailOutput, handle: string, body: { text?: string; html?: string; bodyTruncated?: boolean }): EmailDetail {
    if (row.direction === 'sent') {
      return {
        id: handle,
        direction: 'sent',
        from: row.from,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        ...(row.replyTo !== undefined && row.replyTo.length > 0 ? { replyTo: row.replyTo } : {}),
        subject: row.subject,
        date: row.sentAt,
        status: row.status,
        ...(row.deliveryEvents !== undefined && row.deliveryEvents.length > 0 ? { deliveryEvents: distinctEvents(row.deliveryEvents) } : {}),
        ...body,
        rawAvailable: this.rawDownload(row) !== undefined,
        attachments: rowAttachments(row).map(publicDescriptor),
        hasAttachments: row.attachmentCount > 0,
        attachmentCount: row.attachmentCount,
        sizeBytes: row.sizeBytes,
      };
    }
    const failed = row.pk === FAILED_PARTITION;
    const rawAvailable = this.rawDownload(row) !== undefined;
    return {
      id: handle,
      direction: 'inbound',
      from: row.from,
      ...(row.fromName !== undefined ? { fromName: row.fromName } : {}),
      to: row.to,
      cc: row.cc,
      ...(row.replyTo !== undefined && row.replyTo.length > 0 ? { replyTo: row.replyTo } : {}),
      subject: row.subject,
      date: row.receivedAt,
      ...(row.headerDate !== undefined ? { headerDate: row.headerDate } : {}),
      ...body,
      rawAvailable,
      // Downloadable, but without an affirmative virus PASS: the client must warn first.
      ...(rawAvailable && row.virusVerdict !== 'PASS' ? { rawSuspicious: true } : {}),
      attachments: row.attachments.map(publicDescriptor),
      hasAttachments: row.hasAttachments,
      attachmentCount: row.attachmentCount,
      quarantined: row.quarantined,
      spamVerdict: row.spamVerdict,
      virusVerdict: row.virusVerdict,
      parseStatus: row.parseStatus,
      ...(failed ? { failed: true } : {}),
      sizeBytes: row.sizeBytes,
    };
  }

  /**
   * Where a message's downloadable original lives, or undefined when it may not be downloaded.
   *
   * - Sent: our own archive (permanent).
   * - Errors folder: its quarantined copy — offered whatever the verdict (it is the only way to
   *   recover the content), with the detail flagging a non-PASS one as suspicious.
   * - Received: only on an affirmative virus `PASS` — spam-flagged mail stays downloadable, the
   *   original is the point — and only while SES's raw copy is retained: ingest tags it once the
   *   message is stored, and the lifecycle rule expires it after the window.
   */
  private rawDownload(row: GetEmailOutput): { readonly key: string; readonly presigner: AttachmentPresigner } | undefined {
    if (row.direction === 'sent') {
      return { key: row.rawS3Key, presigner: this.presigner };
    }
    if (row.pk === FAILED_PARTITION) {
      return row.quarantineS3Key && this.quarantinePresigner ? { key: row.quarantineS3Key, presigner: this.quarantinePresigner } : undefined;
    }
    if (row.virusVerdict !== 'PASS') {
      return undefined;
    }
    const ageMs = this.now().getTime() - Date.parse(row.receivedAt);
    return ageMs < INBOUND_RAW_RETENTION_DAYS * DAY_MS ? { key: row.rawS3Key, presigner: this.presigner } : undefined;
  }
}

/**
 * SNS delivers a report at least once, so the row can hold repeats: keep the first of each, in
 * arrival order.
 */
function distinctEvents(events: readonly DeliveryEvent[]): DeliveryEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.type, event.at, event.recipients, event.detail]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** A row's stored attachment descriptors. */
function rowAttachments(row: GetEmailOutput): readonly InboundAttachmentDescriptor[] {
  return row.attachments;
}

/**
 * Bound a body in real UTF-8 bytes (the parser retains by char count) and hard-cap the
 * JSON-escaped payload so a hostile body can't exceed the Lambda response budget — combined
 * with the already-measured envelope. See fitBodyToBudget. A body cut at storage time stays
 * flagged truncated.
 */
function fitToResponse(content: MailBodyContent, envelopeBytes: number): { text?: string; html?: string; bodyTruncated?: boolean } {
  const fitted = fitBodyToBudget(content.text, content.html, {
    partCapBytes: MAX_READ_BODY_BYTES,
    serializedBudgetBytes: Math.max(0, MAX_EMAIL_RESPONSE_BYTES - envelopeBytes),
  });
  return {
    ...(fitted.text !== undefined ? { text: fitted.text } : {}),
    ...(fitted.html !== undefined ? { html: fitted.html } : {}),
    ...(fitted.truncated || content.truncated ? { bodyTruncated: true } : {}),
  };
}

/** Characters that are unsafe in a filename on common filesystems — replaced, not dropped. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;
/** Max code points of the subject kept in the `.eml` filename. */
const MAX_EML_STEM_CHARS = 80;

/** `<subject>.eml`, or `message.eml` for an empty subject. Header-safety is contentDispositionForDownload's job. */
function emlFilename(subject: string): string {
  const stem = Array.from(subject.replace(UNSAFE_FILENAME_CHARS, '_').trim()).slice(0, MAX_EML_STEM_CHARS).join('').trim();
  return `${stem || 'message'}.eml`;
}

/** Strip the server-only S3 key — the client gets only the addressable attachment id. */
function publicDescriptor(descriptor: { id: string; filename: string; contentType: string; sizeBytes: number }): EmailAttachmentInfo {
  return {
    id: descriptor.id,
    filename: descriptor.filename,
    contentType: descriptor.contentType,
    sizeBytes: descriptor.sizeBytes,
  };
}
