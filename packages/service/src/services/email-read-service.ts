/**
 * The read side of the mailbox: list the merged sent/inbound timeline, read one message,
 * and mint a presigned download URL for one attachment. Injectable (repo + presigner + body
 * store + raw-MIME source + clock + parser) so every branch is testable without AWS, and so
 * #13's MCP read tools can reuse this exact service — the REST routes are thin adapters,
 * mirroring how #6's send route and #7's MCP tool share one {@link EmailService}.
 *
 * Bodies: a message's decoded body is stored when it is ingested or sent — inline in the row,
 * or in S3 for a large one — so opening it is a row read, never a raw-MIME parse. INBOUND mail
 * is still gated on the stored verdicts (fail-closed via `decideExposure`): only an exposable
 * message ever has a stored body, and a quarantined one yields none. HTML is returned RAW as
 * data — the client owns safe rendering (#12).
 *
 * Legacy rows (written before bodies were stored) fall back to the old path: re-parse the raw
 * MIME through #10's `parseInbound` (no-op attachment sink, same untrusted-MIME hardening),
 * with `assumeExposed` for our own sent archive. Inbound raw MIME expires after
 * {@link INBOUND_RAW_RETENTION_DAYS} days, after which such a row reads envelope-only.
 */
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_URL_TTL_SECONDS,
  type AttachmentDownloadResponse,
  type EmailAttachmentInfo,
  type EmailDetail,
  type EmailListFilter,
  type EmailListItem,
  type ListEmailsResponse,
  MAX_EMAIL_RESPONSE_BYTES,
  MAX_READ_BODY_BYTES,
  type RawEmailDownloadResponse,
} from '@freemail/shared';
import {
  type EmailsDao,
  FAILED_PARTITION,
  type EmailSummary,
  type GetEmailOutput,
  type InboundAttachmentDescriptor,
} from '../data/emails-dao.js';
import { INBOUND_RAW_RETENTION_DAYS } from '@freemail/shared/storage';
import type { AttachmentPresigner } from '../facades/s3-attachment-presigner.js';
import type { MailBodyContent, MailBodyStore } from '../facades/s3-mail-body-store.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HTML_BODY_BYTES,
  MAX_MIME_PARTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_TEXT_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
} from '../utils/inbound-limits.js';
import {
  type AttachmentSink,
  type ParsedInbound,
  type ParseLimits,
  type ParseOptions,
  parseInbound,
} from '../utils/inbound-parse.js';
import { decideExposure } from '../utils/verdicts.js';
import { fitBodyToBudget } from '../utils/body-budget.js';
import { contentDispositionForDownload } from '../utils/content-disposition.js';
import { decodeEmailRef, encodeEmailRef } from '../utils/email-ref.js';
import { emailErrors } from '../utils/errors.js';
import { listEmailsPage } from '../utils/list-merge.js';
import { getLogger } from '../utils/logger.js';
import { loadEmailBody } from './email-body-storage.js';

/** The raw-MIME source legacy rows re-parse their bodies from — satisfied by the inbound S3 store. */
export interface RawMimeSource {
  getStream(key: string): Promise<Readable>;
}

/** The parse function — defaulted to #10's `parseInbound`, overridable in tests. */
export type ParseInbound = (
  source: Readable,
  sink: AttachmentSink,
  limits?: ParseLimits,
  options?: ParseOptions,
) => Promise<ParsedInbound>;

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
  readonly rawMime: RawMimeSource;
  readonly now?: () => Date;
  readonly parse?: ParseInbound;
}

export interface ListEmailsServiceRequest {
  readonly direction?: EmailListFilter;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * Read limits for on-demand body materialization: identical to #10's parse limits (so the
 * exposure decision can't drift) EXCEPT we retain more of the body — up to the per-part read
 * cap — instead of only a snippet-sized slice. Typed as `ParseLimits`, so if #10 adds a limit
 * field this fails to compile until updated (no silent drift).
 */
const READ_PARSE_LIMITS: ParseLimits = {
  maxRawBytes: MAX_RAW_MESSAGE_BYTES,
  maxChildNodes: MAX_MIME_PARTS,
  maxHeadSize: MAX_HEADER_BLOCK_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxAttachmentTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
  maxTextBodyBytes: MAX_TEXT_BODY_BYTES,
  maxHtmlBodyBytes: MAX_HTML_BODY_BYTES,
  maxTotalBodyBytes: MAX_TOTAL_BODY_BYTES,
  maxRetainedBodyChars: MAX_READ_BODY_BYTES,
};

const logger = getLogger('EmailReadService');

/** S3's error name for a missing object — an expired raw message on the legacy path. */
const NO_SUCH_KEY = 'NoSuchKey';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A no-op attachment sink: the reader re-parses only for the body, never re-storing attachments. */
const NOOP_SINK: AttachmentSink = {
  store: (partIndex, filename, contentType, bytes) =>
    Promise.resolve({
      id: String(partIndex),
      filename: filename ?? '',
      contentType,
      sizeBytes: bytes.length,
      s3Key: '',
    }),
};

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
  private readonly rawMime: RawMimeSource;
  private readonly now: () => Date;
  private readonly parse: ParseInbound;

  constructor(deps: EmailReadServiceDeps) {
    this.emailsDao = deps.emailsDao;
    this.presigner = deps.presigner;
    this.quarantinePresigner = deps.quarantinePresigner;
    this.bodies = deps.bodies;
    this.rawMime = deps.rawMime;
    this.now = deps.now ?? (() => new Date());
    this.parse = deps.parse ?? parseInbound;
  }

  /** List the merged (or direction-filtered) timeline, newest-first, one opaque-cursor page. */
  async listEmails(request: ListEmailsServiceRequest): Promise<ListEmailsResponse> {
    const page = await listEmailsPage({
      query: async (direction, opts) =>
        (await this.emailsDao.listEmailSummaries({ direction, ...opts })).emails,
      ...(request.direction ? { direction: request.direction } : {}),
      limit: request.limit,
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    return {
      emails: page.rows.map((row) => this.toListItem(row)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /** Read one message. Received + exposable → body materialized; otherwise envelope-only. */
  async getEmail(request: GetEmailServiceRequest): Promise<GetEmailServiceResponse> {
    const row = await this.loadRow(request.handle);
    // Size the envelope first so the body budget accounts for the WHOLE response, not just
    // the body — the combined serialized bytes must stay under the Lambda response limit.
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(this.toDetail(row, request.handle, {})),
      'utf8',
    );
    const body = await this.materializeBody(row, envelopeBytes);
    return this.toDetail(row, request.handle, body);
  }

  /**
   * Mint a presigned download URL for one attachment. Only descriptors actually on the row
   * are addressable — a quarantined/virus/parse-failed message has none, and neither does a
   * sent row written before attachments were recorded — so the id resolves to nothing → 404,
   * never a guessable key. The raw S3 key is used server-side only.
   */
  async getAttachmentUrl(
    request: GetAttachmentUrlServiceRequest,
  ): Promise<AttachmentDownloadResponse> {
    const row = await this.loadRow(request.handle);
    const descriptor = rowAttachments(row).find((a) => a.id === request.attachmentId);
    if (!descriptor) {
      throw emailErrors.notFound('No such attachment.');
    }
    const url = await this.presigner.presign({
      key: descriptor.s3Key,
      // Force a non-inline download regardless of the object's stored metadata.
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload(descriptor.filename),
      expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    });
    const expiresAt = new Date(
      this.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000,
    ).toISOString();
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
    const expiresAt = new Date(
      this.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000,
    ).toISOString();
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
  private async materializeBody(
    row: GetEmailOutput,
    envelopeBytes: number,
  ): Promise<{ text?: string; html?: string; bodyTruncated?: boolean }> {
    if (row.direction === 'inbound') {
      // Gate on the STORED verdicts first — a non-exposable row never yields a body, whatever
      // it carries (ingest stores none for one, so this is defense in depth).
      const exposure = decideExposure(
        { spamVerdict: row.spamVerdict, virusVerdict: row.virusVerdict },
        row.parseStatus,
      );
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
    return this.legacyBody(row, envelopeBytes);
  }

  /**
   * A row written before bodies were stored: re-parse its raw MIME, as the reader used to.
   * Our own sent archive is permanent and always exposable (`assumeExposed`); a legacy sent
   * row without one (pre-#29) stays envelope-only. Inbound raw MIME expires, so once it is
   * gone the row reads envelope-only too.
   */
  private async legacyBody(
    row: GetEmailOutput,
    envelopeBytes: number,
  ): Promise<{ text?: string; html?: string; bodyTruncated?: boolean }> {
    if (row.direction === 'sent') {
      if (!row.rawS3Key) {
        return {};
      }
      return this.parseBody(row.rawS3Key, envelopeBytes, { assumeExposed: true });
    }
    return this.parseBody(row.rawS3Key, envelopeBytes, {});
  }

  /**
   * Re-parse a raw MIME object into a body fitted to the response budget. `parsed.exposed` is
   * the defense-in-depth fail-closed — a corrupt/parse-failed archive yields no body rather
   * than throwing — and an expired (deleted) object yields none either.
   */
  private async parseBody(
    rawS3Key: string,
    envelopeBytes: number,
    options: ParseOptions,
  ): Promise<{ text?: string; html?: string; bodyTruncated?: boolean }> {
    let stream: Readable;
    try {
      stream = await this.rawMime.getStream(rawS3Key);
    } catch (err) {
      if (err instanceof Error && err.name === NO_SUCH_KEY) {
        return {};
      }
      throw err;
    }
    const parsed = await this.parse(stream, NOOP_SINK, READ_PARSE_LIMITS, options);
    if (!parsed.exposed) {
      return {};
    }
    return fitToResponse({ text: parsed.textBody, html: parsed.htmlBody }, envelopeBytes);
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
        ...(row.status !== undefined ? { status: row.status } : {}),
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

  private toDetail(
    row: GetEmailOutput,
    handle: string,
    body: { text?: string; html?: string; bodyTruncated?: boolean },
  ): EmailDetail {
    if (row.direction === 'sent') {
      return {
        id: handle,
        direction: 'sent',
        from: row.from,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        subject: row.subject,
        date: row.sentAt,
        ...(row.status !== undefined ? { status: row.status } : {}),
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
   * - Sent: our own archive, if the row has one (permanent).
   * - Errors folder: its quarantined copy — offered whatever the verdict (it is the only way to
   *   recover the content), with the detail flagging a non-PASS one as suspicious.
   * - Received, fully processed (a stored body): only on an affirmative virus `PASS` — spam-
   *   flagged mail stays downloadable, the original is the point — and only while SES's raw
   *   copy is retained (the lifecycle rule expires tagged copies).
   * - Received before stored bodies: its untagged raw copy, kept forever, whatever the verdict —
   *   flagged suspicious without a virus PASS.
   */
  private rawDownload(
    row: GetEmailOutput,
  ): { readonly key: string; readonly presigner: AttachmentPresigner } | undefined {
    if (row.direction === 'sent') {
      return row.rawS3Key ? { key: row.rawS3Key, presigner: this.presigner } : undefined;
    }
    if (row.pk === FAILED_PARTITION) {
      return row.quarantineS3Key && this.quarantinePresigner
        ? { key: row.quarantineS3Key, presigner: this.quarantinePresigner }
        : undefined;
    }
    // A row without a stored body predates stored bodies: its raw copy is untagged and kept
    // forever — the only way to recover the message — so offer it whatever the verdict, like an
    // Errors-folder original (the detail flags one without a virus PASS as suspicious).
    if (row.body === undefined) {
      return { key: row.rawS3Key, presigner: this.presigner };
    }
    // A row with a stored body was fully extracted (virus PASS by construction), so ingest tagged
    // its raw copy and the lifecycle rule expires it after the window: offer it only until then.
    if (row.virusVerdict !== 'PASS') {
      return undefined;
    }
    const ageMs = this.now().getTime() - Date.parse(row.receivedAt);
    return ageMs < INBOUND_RAW_RETENTION_DAYS * DAY_MS
      ? { key: row.rawS3Key, presigner: this.presigner }
      : undefined;
  }
}

/** A row's stored attachment descriptors; a sent row from before they were recorded has none. */
function rowAttachments(row: GetEmailOutput): readonly InboundAttachmentDescriptor[] {
  return row.direction === 'inbound' ? row.attachments : (row.attachments ?? []);
}

/**
 * Bound a body in real UTF-8 bytes (the parser retains by char count) and hard-cap the
 * JSON-escaped payload so a hostile body can't exceed the Lambda response budget — combined
 * with the already-measured envelope. See fitBodyToBudget. A body cut at storage time stays
 * flagged truncated.
 */
function fitToResponse(
  content: MailBodyContent,
  envelopeBytes: number,
): { text?: string; html?: string; bodyTruncated?: boolean } {
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
  const stem = Array.from(subject.replace(UNSAFE_FILENAME_CHARS, '_').trim())
    .slice(0, MAX_EML_STEM_CHARS)
    .join('')
    .trim();
  return `${stem || 'message'}.eml`;
}

/** Strip the server-only S3 key — the client gets only the addressable attachment id. */
function publicDescriptor(descriptor: {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): EmailAttachmentInfo {
  return {
    id: descriptor.id,
    filename: descriptor.filename,
    contentType: descriptor.contentType,
    sizeBytes: descriptor.sizeBytes,
  };
}
