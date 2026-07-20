/**
 * Send-email orchestration — the single place send logic lives, so the REST route
 * and the MCP `send_email` tool (#7) are both thin wrappers over the SAME
 * validation + send + record flow. All I/O (SES, DynamoDB, S3, the MIME builder) is
 * injected, so every branch is unit-testable without AWS.
 *
 * Validation is deliberately here (not in the handler): the sender-domain check
 * and payload caps must hold for every caller, REST or MCP.
 *
 * Large attachments (#14): an attachment larger than {@link MAX_EMBED_ATTACHMENT_BYTES}
 * is NOT embedded in the MIME — it's uploaded to S3, a download token is minted, and a
 * `GET /d/{token}` link is appended to the body. Smaller ones embed as before. The same
 * routing applies to REST and MCP callers because both send through this one service.
 */
import {
  DOWNLOAD_TOKEN_TTL_SECONDS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_EMBED_ATTACHMENT_BYTES,
  MAX_RAW_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  isSubdomainOrEqual,
  isValidEmailAddress,
  normalizeDomain,
  type SendEmailRequest,
  type SendEmailResponse,
} from '@freemail/shared';
import type { DownloadTokensRepo } from '../data/download-tokens-repo.js';
import type { EmailsRepo, SentStatusUpdate } from '../data/emails-repo.js';
import type { OutboundObjectStore } from '../data/outbound-object-store.js';
import { appendDownloadLinks, type DownloadLink } from './attachment-links.js';
import { downloadUrl, generateDownloadToken, outboundAttachmentKey } from './download-token.js';
import { emailErrors } from './errors.js';
import { buildRawMime, type RawMimeAttachment, type RawMimeInput } from './mime.js';
import type { SesSender } from './ses-sender.js';

export interface EmailServiceDeps {
  readonly ses: SesSender;
  readonly emails: EmailsRepo;
  /**
   * Stores send-path objects in the mail bucket: outbound large attachments (#14,
   * `attachments/outbound/*`) and the archived composed raw MIME (#29, `sent/<id>`). The
   * archive is only ever re-read server-side, so the store's octet-stream disposition is harmless.
   */
  readonly objectStore: OutboundObjectStore;
  /** Persists the download tokens minted for large attachments (#14). */
  readonly tokens: DownloadTokensRepo;
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

/** A validated attachment plus its decoded bytes — the input to embed-vs-link routing. */
interface ProcessedAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly bytes: Buffer;
  readonly sizeBytes: number;
}

export class EmailService {
  private readonly ses: SesSender;
  private readonly emails: EmailsRepo;
  private readonly objectStore: OutboundObjectStore;
  private readonly tokens: DownloadTokensRepo;
  private readonly downloadBaseUrl: string;
  private readonly emailDomain: string;
  private readonly buildMime: (input: RawMimeInput) => Promise<Buffer>;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly generateToken: () => string;

  constructor(deps: EmailServiceDeps) {
    this.ses = deps.ses;
    this.emails = deps.emails;
    this.objectStore = deps.objectStore;
    this.tokens = deps.tokens;
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

    const processed = this.validateAttachments(request.attachments);

    // Allocate the id up front: it namespaces any large-attachment S3 keys and correlates
    // the token rows, and it must appear in the (best-effort) metadata row later.
    const id = this.generateId();
    const nowDate = this.now();

    // Route each attachment: embed small ones in the MIME, upload large ones + mint a link.
    const embed: RawMimeAttachment[] = [];
    const large: ProcessedAttachment[] = [];
    for (const attachment of processed) {
      if (attachment.sizeBytes > MAX_EMBED_ATTACHMENT_BYTES) {
        large.push(attachment);
      } else {
        embed.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentBase64: attachment.contentBase64,
        });
      }
    }
    const links = await this.uploadLargeAttachments(large, id, nowDate);
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

    // Write-before-send (#29), FAIL-CLOSED: archive the EXACT composed MIME, then record the
    // attempt as `status:'sending'` — both BEFORE SES. A failure in either throws (no send),
    // so we never send a message we couldn't archive + record; the caller can retry with a
    // fresh id. An orphan `sent/<id>` object from a later putSent failure is harmless (RETAINed).
    await this.objectStore.put(rawS3Key, raw);
    await this.emails.putSent({
      id,
      from,
      to,
      cc,
      bcc,
      subject: request.subject ?? '',
      sentAt,
      attachmentCount: processed.length,
      sizeBytes: raw.length,
      status: 'sending',
      rawS3Key,
    });

    let messageId: string;
    try {
      ({ messageId } = await this.ses.send({ from, to, cc, bcc, raw }));
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
  private async recordTerminalStatus(update: SentStatusUpdate): Promise<void> {
    try {
      await this.emails.updateSentStatus(update);
    } catch (error) {
      console.error(
        'Failed to update sent-email status',
        { emailId: update.id, status: update.status },
        error,
      );
    }
  }

  /**
   * Upload each large attachment to S3, mint a download token per file, and return the
   * links to inject into the body. Uploads/token writes happen BEFORE the SES send (the
   * links must be in the MIME); a later send failure leaves harmless orphans that expire
   * with the token TTL. `generateToken`/`now` are injected for deterministic tests.
   */
  private async uploadLargeAttachments(
    large: ProcessedAttachment[],
    emailId: string,
    nowDate: Date,
  ): Promise<DownloadLink[]> {
    if (large.length === 0) {
      return [];
    }
    const createdAt = nowDate.toISOString();
    const expiresMs = nowDate.getTime() + DOWNLOAD_TOKEN_TTL_SECONDS * 1000;
    const expiresAt = new Date(expiresMs).toISOString();
    const ttl = Math.floor(expiresMs / 1000);

    const links: DownloadLink[] = [];
    for (let index = 0; index < large.length; index += 1) {
      const attachment = large[index];
      const token = this.generateToken();
      const s3Key = outboundAttachmentKey(emailId, index);
      await this.objectStore.put(s3Key, attachment.bytes);
      await this.tokens.create({
        token,
        s3Key,
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

  private validateAttachments(attachments: SendEmailRequest['attachments']): ProcessedAttachment[] {
    if (attachments === undefined || attachments.length === 0) {
      return [];
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      throw emailErrors.invalidRequest(
        `A message may have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    let totalBytes = 0;
    const normalized: ProcessedAttachment[] = [];
    for (const attachment of attachments) {
      const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : '';
      if (filename.length === 0) {
        throw emailErrors.invalidRequest('Each attachment requires a "filename".');
      }
      const contentType =
        typeof attachment.contentType === 'string' ? attachment.contentType.trim() : '';
      if (contentType.length === 0) {
        throw emailErrors.invalidRequest(`Attachment "${filename}" requires a "contentType".`);
      }
      const contentBase64 =
        typeof attachment.contentBase64 === 'string'
          ? attachment.contentBase64.replace(/\s+/g, '')
          : '';
      const decoded = Buffer.from(contentBase64, 'base64');
      // Canonical base64 only: decode then re-encode must round-trip. This rejects
      // non-alphabet characters, bad padding, and non-multiple-of-4 lengths that
      // Buffer.from would otherwise silently drop (corrupting the attachment).
      if (contentBase64.length === 0 || decoded.toString('base64') !== contentBase64) {
        throw emailErrors.invalidRequest(
          `Attachment "${filename}" must have valid base64 content.`,
        );
      }
      totalBytes += decoded.length;
      // The whole request (embedded + linked bytes) still arrives base64 in one JSON body,
      // so the total cap is the binding limit regardless of how each attachment is routed.
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw emailErrors.invalidRequest(
          `Total attachment size exceeds ${MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
        );
      }
      normalized.push({
        filename,
        contentType,
        contentBase64,
        bytes: decoded,
        sizeBytes: decoded.length,
      });
    }
    return normalized;
  }
}

/** Max chars of a `send_failed` reason kept on the row — bounds an unexpectedly verbose SES error. */
const MAX_ERROR_LENGTH = 1000;

/**
 * S3 key for a sent message's archived composed raw MIME. Opaque, namespaced by the send id;
 * mirrors the inbound layout (`inbound/<id>`). The read path re-parses this on demand.
 */
export function sentRawKey(id: string): string {
  return `sent/${id}`;
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
