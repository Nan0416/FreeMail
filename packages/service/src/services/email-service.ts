/**
 * Send-email orchestration — the single place send logic lives, so the REST route
 * and the MCP `send_email` tool (#7) are both thin wrappers over the SAME
 * validation + send + record flow. All I/O (SES, DynamoDB, S3, the MIME builder) is
 * injected, so every branch is unit-testable without AWS.
 *
 * Validation is deliberately here (not in the handler): the sender-domain check
 * and payload caps must hold for every caller, REST or MCP.
 *
 * Attachments arrive as references to finished uploads (`uploads/<uploadId>`, see
 * {@link AttachmentUploadService}) — never as bytes in the request. Each is copied once to its
 * permanent key, `attachments/sent/<id>/<index>`. Small ones are also embedded in the MIME, as
 * long as the message's embedded total stays within budget; the rest get a download token and a
 * `GET /d/{token}` link appended to the body (#14). The same routing applies to REST and MCP
 * callers because both send through this one service.
 */
import {
  DEFAULT_EMBED_ATTACHMENT_BYTES,
  DEFAULT_EMBED_TOTAL_BYTES,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  MAX_ATTACHMENTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_RECIPIENTS,
  isSubdomainOrEqual,
  isValidEmailAddress,
  normalizeDomain,
  type SendEmailRequest,
  type SendEmailResponse,
} from '@freemail/shared';
import type { DownloadTokensDao } from '../data/download-tokens-dao.js';
import type {
  CreateSentEmailInput,
  EmailsDao,
  UpdateSentEmailStatusInput,
} from '../data/emails-dao.js';
import type { MailBodyStore } from '../facades/s3-mail-body-store.js';
import type { OutboundObjectStore } from '../facades/s3-outbound-object-store.js';
import { appendDownloadLinks, type DownloadLink } from '../utils/attachment-links.js';
import type { UploadStore } from '../facades/s3-upload-store.js';
import { downloadUrl, generateDownloadToken } from '../utils/download-token.js';
import { emailErrors } from '../utils/errors.js';
import { buildRawMime, type RawMimeAttachment, type RawMimeInput } from '../utils/mime.js';
import type { SesSender } from '../facades/ses-email-facade.js';
import { isValidUploadId, uploadKey } from './attachment-upload-service.js';
import { bodyKey, estimateRowBytes, storeEmailBody } from './email-body-storage.js';

export interface EmailServiceDeps {
  readonly ses: SesSender;
  readonly emailsDao: EmailsDao;
  /**
   * Stores send-path objects in the mail bucket: outbound large attachments (#14,
   * `attachments/outbound/*`), the archived composed raw MIME (#29, `sent/<id>`), and a
   * downloadable copy of each embedded attachment (`attachments/sent/<id>/<index>`). The
   * octet-stream disposition suits all three — attachments are only ever served as downloads.
   */
  readonly objectStore: OutboundObjectStore;
  /** Stores a sent body too large to keep inline in the row (`bodies/sent/<id>.json`). */
  readonly bodies: MailBodyStore;
  /** Persists the download tokens minted for large attachments (#14). */
  readonly tokensDao: DownloadTokensDao;
  /** Reads finished attachment uploads (`uploads/<id>`) and copies them to their permanent key. */
  readonly uploads: UploadStore;
  /** Embed an attachment at most this size (bytes); larger ones are linked. Deploy-configurable. */
  readonly embedMaxBytes?: number;
  /** Cap on the embedded attachments of one message (bytes); beyond it they are linked. */
  readonly embedTotalBytes?: number;
  /** Public base URL for download links — the API's own endpoint (`https://…`). */
  readonly downloadBaseUrl: string;
  /** The domain every `from` must be under (the configured send domain). */
  readonly emailDomain: string;
  /** MIME builder; injectable so service tests don't depend on the MIME library. */
  readonly buildMime?: (input: RawMimeInput) => Promise<Buffer>;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Id generator, injectable for tests. */
  readonly generateId?: () => string;
  /** Download-token generator, injectable for tests. */
  readonly generateToken?: () => string;
}

/** A finished upload, as S3 reports it, in request order — the input to embed-vs-link routing. */
interface ResolvedAttachment {
  readonly uploadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Embedded in the MIME (true) or delivered as a download link (false). */
  readonly embed: boolean;
}

export class EmailService {
  private readonly ses: SesSender;
  private readonly emailsDao: EmailsDao;
  private readonly objectStore: OutboundObjectStore;
  private readonly bodies: MailBodyStore;
  private readonly tokensDao: DownloadTokensDao;
  private readonly uploads: UploadStore;
  private readonly embedMaxBytes: number;
  private readonly embedTotalBytes: number;
  private readonly downloadBaseUrl: string;
  private readonly emailDomain: string;
  private readonly buildMime: (input: RawMimeInput) => Promise<Buffer>;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly generateToken: () => string;

  constructor(deps: EmailServiceDeps) {
    this.ses = deps.ses;
    this.emailsDao = deps.emailsDao;
    this.objectStore = deps.objectStore;
    this.bodies = deps.bodies;
    this.tokensDao = deps.tokensDao;
    this.uploads = deps.uploads;
    this.embedMaxBytes = deps.embedMaxBytes ?? DEFAULT_EMBED_ATTACHMENT_BYTES;
    this.embedTotalBytes = deps.embedTotalBytes ?? DEFAULT_EMBED_TOTAL_BYTES;
    this.downloadBaseUrl = deps.downloadBaseUrl;
    this.emailDomain = normalizeDomain(deps.emailDomain);
    this.buildMime = deps.buildMime ?? buildRawMime;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
    this.generateToken = deps.generateToken ?? generateDownloadToken;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResponse> {
    const from = this.validateSender(request.from);
    const fromName = optionalTrimmed(request.fromName);

    const to = normalizeRecipients(request.to);
    const cc = normalizeRecipients(request.cc);
    const bcc = normalizeRecipients(request.bcc);
    const recipients = [...to, ...cc, ...bcc];
    if (recipients.length === 0) {
      throw emailErrors.invalidRequest('At least one recipient (to, cc, or bcc) is required.');
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw emailErrors.invalidRequest(`A message may have at most ${MAX_RECIPIENTS} recipients.`);
    }
    for (const address of recipients) {
      if (!isValidEmailAddress(address)) {
        throw emailErrors.invalidRequest(`"${address}" is not a valid email address.`);
      }
    }

    const text = nonEmpty(request.text);
    const html = nonEmpty(request.html);
    if (text === undefined && html === undefined) {
      throw emailErrors.invalidRequest('An email body (text or html) is required.');
    }

    const attachments = await this.resolveAttachments(request.attachments);

    // Allocate the id up front: it namespaces the attachments' permanent keys and correlates
    // the token rows, and it must appear in the (best-effort) metadata row later.
    const id = this.generateId();
    const nowDate = this.now();

    // Copy every upload to its permanent key first — the one copy the reader, a download link,
    // and the row's descriptor all point at. Write-before-send: a failure here throws (no send).
    for (let index = 0; index < attachments.length; index += 1) {
      await this.uploads.copy(uploadKey(attachments[index].uploadId), sentAttachmentKey(id, index));
    }
    const embed: RawMimeAttachment[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment.embed) {
        const bytes = await this.uploads.getBytes(sentAttachmentKey(id, index));
        embed.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentBase64: bytes.toString('base64'),
        });
      }
    }
    const links = await this.mintDownloadLinks(attachments, id, nowDate);
    const body = appendDownloadLinks(
      {
        ...(text !== undefined ? { text } : {}),
        ...(html !== undefined ? { html } : {}),
      },
      links,
    );

    const raw = await this.buildMime({
      from,
      ...(fromName !== undefined ? { fromName } : {}),
      to,
      cc,
      bcc,
      subject: request.subject ?? '',
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.html !== undefined ? { html: body.html } : {}),
      attachments: embed,
    });
    if (raw.length > MAX_RAW_MESSAGE_BYTES) {
      throw emailErrors.invalidRequest('The assembled message exceeds the maximum size.');
    }

    const sentAt = nowDate.toISOString();
    const rawS3Key = sentRawKey(id);

    // Write-before-send (#29), FAIL-CLOSED: archive the EXACT composed MIME, a downloadable
    // copy of every embedded attachment, and the body (inline, or `bodies/sent/<id>.json`),
    // then record the attempt as `status:'sending'` — all
    // BEFORE SES. A failure in any throws (no send), so we never send a message we couldn't
    // archive + record; the caller can retry with a fresh id. Orphan objects from a later
    // failure are harmless (RETAINed).
    await this.objectStore.put(rawS3Key, raw);
    const record: CreateSentEmailInput = {
      id,
      from,
      to,
      cc,
      bcc,
      subject: request.subject ?? '',
      sentAt,
      attachmentCount: attachments.length,
      sizeBytes: raw.length,
      status: 'sending',
      rawS3Key,
      attachments: attachments.map((attachment, index) => ({
        id: String(index),
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        s3Key: sentAttachmentKey(id, index),
      })),
    };
    // The body exactly as sent (download links included), so opening it never re-parses the
    // archive — sized against the rest of the row, which the send path does not cap.
    const storedBody = await storeEmailBody(this.bodies, {
      key: bodyKey('sent', id),
      text: body.text,
      html: body.html,
      otherRowBytes: estimateRowBytes(record),
    });
    await this.emailsDao.createSentEmail({ ...record, body: storedBody });

    let messageId: string;
    try {
      messageId = (await this.ses.send({ from, to, cc, bcc, raw })).messageId;
    } catch (error) {
      // SES rejected the message: mark the archived row send_failed so the failure is visible
      // in the mailbox, then surface the error to the caller (delivery did not happen).
      await this.recordTerminalStatus({
        id,
        sentAt,
        status: 'send_failed',
        error: describeError(error),
      });
      throw error;
    }

    // Delivered: mark sent (+ the SES id). Best-effort — the mail is already out, so this must
    // not fail the response; a lost update leaves the row at 'sending' (self-describing).
    await this.recordTerminalStatus({ id, sentAt, status: 'sent', sesMessageId: messageId });

    return { id, messageId, sentAt };
  }

  /**
   * Apply the terminal status transition, swallowing a store failure. Durability requirement:
   * a lost update is logged at ERROR (alarmable) with the correlating ids so the sent mail can
   * be reconciled from SES logs — the row simply stays `sending` rather than corrupting.
   */
  private async recordTerminalStatus(update: UpdateSentEmailStatusInput): Promise<void> {
    try {
      await this.emailsDao.updateSentEmailStatus(update);
    } catch (error) {
      console.error(
        'Failed to update sent-email status',
        { emailId: update.id, status: update.status },
        error,
      );
    }
  }

  /**
   * Mint a download token for each linked (not embedded) attachment and return the links to
   * append to the body. A token points at the attachment's permanent copy, so the link works
   * for the token's lifetime while the sender's own access (via the Sent folder) never expires.
   * Token writes happen BEFORE the SES send (the links must be in the MIME); a later send
   * failure leaves harmless orphans that expire with the token TTL.
   */
  private async mintDownloadLinks(
    attachments: readonly ResolvedAttachment[],
    emailId: string,
    nowDate: Date,
  ): Promise<DownloadLink[]> {
    const createdAt = nowDate.toISOString();
    const expiresMs = nowDate.getTime() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000;
    const expiresAt = new Date(expiresMs).toISOString();
    const ttl = Math.floor(expiresMs / 1000);

    const links: DownloadLink[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment.embed) {
        continue;
      }
      const token = this.generateToken();
      await this.tokensDao.createDownloadToken({
        token,
        s3Key: sentAttachmentKey(emailId, index),
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        emailId,
        createdAt,
        expiresAt,
        ttl,
        revoked: false,
        downloadCount: 0,
      });
      links.push({
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        url: downloadUrl(this.downloadBaseUrl, token),
      });
    }
    return links;
  }

  /** Enforce "from any address under the configured domain" — an explicit 400, not a 500 from SES. */
  private validateSender(from: unknown): string {
    if (typeof from !== 'string' || from.trim().length === 0) {
      throw emailErrors.invalidRequest('"from" is required.');
    }
    const address = from.trim();
    if (!isValidEmailAddress(address)) {
      throw emailErrors.invalidSender(`"${address}" is not a valid email address.`);
    }
    const domain = normalizeDomain(address.slice(address.lastIndexOf('@') + 1));
    if (!isSubdomainOrEqual(domain, this.emailDomain)) {
      throw emailErrors.invalidSender(
        `"${address}" is not under the configured domain (${this.emailDomain}).`,
      );
    }
    return address;
  }

  /**
   * Resolve each attachment reference to what was really uploaded (a HEAD — never the client's
   * word), in request order, and decide embed vs link: embed while a file is at most
   * `embedMaxBytes` and the message's embedded total stays within `embedTotalBytes`.
   */
  private async resolveAttachments(
    refs: SendEmailRequest['attachments'],
  ): Promise<ResolvedAttachment[]> {
    if (refs === undefined || refs.length === 0) {
      return [];
    }
    if (!Array.isArray(refs) || refs.length > MAX_ATTACHMENTS) {
      throw emailErrors.invalidRequest(
        `A message may have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    const resolved: ResolvedAttachment[] = [];
    let embeddedBytes = 0;
    for (let index = 0; index < refs.length; index += 1) {
      const uploadId = (refs[index] as { uploadId?: unknown } | undefined)?.uploadId;
      if (!isValidUploadId(uploadId)) {
        throw emailErrors.invalidRequest(
          `"attachments[${index}].uploadId" must be the id of an attachment upload.`,
        );
      }
      const uploaded = await this.uploads.head(uploadKey(uploadId));
      if (uploaded === null) {
        throw emailErrors.invalidRequest(
          `Attachment upload "${uploadId}" was not found — it may never have been uploaded, or it expired. Upload it again.`,
        );
      }
      if (uploaded.sizeBytes > MAX_UPLOAD_BYTES) {
        throw emailErrors.invalidRequest(`Attachment "${uploaded.filename}" is too large.`);
      }
      const embed =
        uploaded.sizeBytes <= this.embedMaxBytes &&
        embeddedBytes + uploaded.sizeBytes <= this.embedTotalBytes;
      if (embed) {
        embeddedBytes += uploaded.sizeBytes;
      }
      resolved.push({ uploadId, ...uploaded, embed });
    }
    return resolved;
  }
}

/** Max chars of a `send_failed` reason kept on the row — bounds an unexpectedly verbose SES error. */
const MAX_ERROR_LENGTH = 1000;

/**
 * S3 key for a sent message's archived composed raw MIME. Opaque, namespaced by the send id;
 * mirrors the inbound layout (`inbound/<id>`). Permanent — it backs the `.eml` download.
 */
export function sentRawKey(id: string): string {
  return `sent/${id}`;
}

/**
 * S3 key for a sent message's attachment (embedded or linked), by its index in the send request:
 * the permanent copy of its upload, behind both the sender's download and a recipient's link.
 * Opaque (never the filename); mirrors the inbound `attachments/inbound/<id>/<part>`.
 */
export function sentAttachmentKey(id: string, index: number): string {
  return `attachments/sent/${id}/${index}`;
}

/** A short, bounded failure reason for a `send_failed` row (server-side only, never in the read DTO). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

/** Trim, drop empty strings; leaves address case untouched (local parts are case-sensitive). */
function normalizeRecipients(list: readonly string[] | undefined): string[] {
  if (list === undefined) {
    return [];
  }
  return list.map((address) => address.trim()).filter((address) => address.length > 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
