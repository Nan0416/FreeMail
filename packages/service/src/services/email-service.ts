/**
 * Send-email orchestration — the single place send logic lives, so the REST route
 * and the MCP `send_email` tool (#7) are both thin wrappers over the SAME
 * validation + send + record flow. All I/O (SES, DynamoDB, S3, the MIME builder) is
 * injected, so every branch is unit-testable without AWS.
 *
 * Validation is deliberately here (not in the handler): the sender-domain check
 * and payload caps must hold for every caller, REST or MCP.
 *
 * Attachments arrive as references — to finished uploads (`uploads/<uploadId>`, see
 * {@link AttachmentService}), or to files already on a message in the mailbox, forwarded as is —
 * never as bytes in the request. Each is copied once to its permanent key,
 * `attachments/sent/<id>/<index>`. Small ones are also embedded in the MIME
 * (first fit, in request order, while the message's embedded total stays within budget); the
 * rest get a download token and a `GET /d/{token}` link appended to the body (#14). The same
 * routing applies to REST and MCP callers because both send through this one service.
 */
import {
  DEFAULT_EMBED_ATTACHMENT_BYTES,
  DEFAULT_EMBED_TOTAL_BYTES,
  DOWNLOAD_TOKEN_TTL_SECONDS,
  MAX_ATTACHMENTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_RECIPIENTS,
  MAX_REPLY_TO_ADDRESSES,
  isSubdomainOrEqual,
  isValidEmailAddress,
  normalizeDomain,
  type SendEmailRequest,
  type SendEmailResponse,
  type StoredAttachmentRef,
} from '@freemail/shared';
import type { DownloadTokensDao } from '../data/download-tokens-dao.js';
import { EmailEntity } from '../data/entities.js';
import type {
  CreateSentEmailInput,
  EmailsDao,
  GetEmailOutput,
  UpdateSentEmailStatusInput,
} from '../data/emails-dao.js';
import type { MailBodyStore } from '../facades/s3-mail-body-store.js';
import type { OutboundObjectStore } from '../facades/s3-outbound-object-store.js';
import { appendDownloadLinks, type DownloadLink } from '../utils/attachment-links.js';
import type { UploadStore, UploadedObject } from '../facades/s3-upload-store.js';
import { downloadUrl, generateDownloadToken } from '../utils/download-token.js';
import { decodeEmailRef, encodeEmailRef } from '../utils/email-ref.js';
import { EmailError, emailErrors } from '../utils/errors.js';
import { decideExposure } from '../utils/verdicts.js';
import { mapBounded } from '../utils/bounded-map.js';
import { buildRawMime, type RawMimeAttachment, type RawMimeInput } from '../utils/mime.js';
import type { SesSender } from '../facades/ses-email-facade.js';
import { isValidUploadId, uploadKey } from './attachment-service.js';
import { bodyKey, estimateRowBytes, storeEmailBody } from './email-body-storage.js';
import { replyReferences, replySubject, sesMessageIdHeader } from '../utils/threading.js';

/** A send, exactly as REST and MCP both receive it. */
export type SendEmailServiceRequest = SendEmailRequest;

export interface EmailServiceDeps {
  readonly ses: SesSender;
  readonly emailsDao: EmailsDao;
  /** Archives the composed raw MIME of each send (#29, `sent/<id>`). */
  readonly objectStore: OutboundObjectStore;
  /** Stores a sent body too large to keep inline in the row (`bodies/sent/<id>.json`). */
  readonly bodies: MailBodyStore;
  /** Persists the download tokens minted for large attachments (#14). */
  readonly tokensDao: DownloadTokensDao;
  /**
   * Reads finished attachment uploads (`uploads/<id>`) — HEAD, and a small one's bytes to embed —
   * and copies them, and any forwarded stored attachment, to their permanent key.
   */
  readonly uploads: UploadStore;
  /** Embed an attachment at most this size (bytes); larger ones are linked. Deploy-configurable. */
  readonly embedMaxBytes?: number;
  /** Cap on the embedded attachments of one message (bytes); beyond it they are linked. */
  readonly embedTotalBytes?: number;
  /** Public base URL for download links — the API's own endpoint (`https://…`). */
  readonly downloadBaseUrl: string;
  /** The domain every `from` must be under (the configured send domain). */
  readonly emailDomain: string;
  /** The region SES sends from — it names the host of the Message-ID SES gives a sent message. */
  readonly sesRegion: string;
  /**
   * Whether this service may read the mailbox to look up the message a reply answers. False on
   * an MCP server without inbound, whose role has no read grant on the emails table. Required,
   * so a new caller decides rather than inheriting a grant it may not have.
   */
  readonly canReadMailbox: boolean;
  /** MIME builder; injectable so service tests don't depend on the MIME library. */
  readonly buildMime?: (input: RawMimeInput) => Promise<Buffer>;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Id generator, injectable for tests. */
  readonly generateId?: () => string;
  /** Download-token generator, injectable for tests. */
  readonly generateToken?: () => string;
}

/**
 * One attachment to send, in request order — a finished upload (as S3 reports it) or a stored
 * attachment being forwarded (as its message's row records it): the input to embed-vs-link.
 */
interface ResolvedAttachment {
  /** Where its bytes are now: `uploads/<id>`, or the forwarded file's own key. */
  readonly sourceKey: string;
  /** The error to give should the source vanish before it is copied. */
  readonly missing: string;
  /** A stored file being forwarded (not an upload). */
  readonly forwarded: boolean;
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
  private readonly sesRegion: string;
  private readonly canReadMailbox: boolean;
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
    this.sesRegion = deps.sesRegion;
    this.canReadMailbox = deps.canReadMailbox;
    this.buildMime = deps.buildMime ?? buildRawMime;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
    this.generateToken = deps.generateToken ?? generateDownloadToken;
  }

  async sendEmail(request: SendEmailServiceRequest): Promise<SendEmailResponse> {
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
    const replyTo = normalizeRecipients(request.replyTo);
    if (replyTo.length > MAX_REPLY_TO_ADDRESSES) {
      throw emailErrors.invalidRequest(
        `"replyTo" may list at most ${MAX_REPLY_TO_ADDRESSES} addresses.`,
      );
    }
    for (const address of replyTo) {
      if (!isValidEmailAddress(address)) {
        throw emailErrors.invalidRequest(`"replyTo": "${address}" is not a valid email address.`);
      }
    }

    const text = nonEmpty(request.text);
    const html = nonEmpty(request.html);
    if (text === undefined && html === undefined) {
      throw emailErrors.invalidRequest('An email body (text or html) is required.');
    }

    const thread =
      request.inReplyTo === undefined ? undefined : await this.resolveThread(request.inReplyTo);
    const subject = request.subject ?? (thread ? replySubject(thread.subject) : '');
    const threadHeaders = thread?.headers;

    const attachments = await this.resolveAttachments(request.attachments);

    // Allocate the id up front: it namespaces the attachments' permanent keys and correlates
    // the token rows, and it must appear in the (best-effort) metadata row later.
    const id = this.generateId();
    const nowDate = this.now();

    // Copy every upload to its permanent key first — the one copy the reader, a download link,
    // and the row's descriptor all point at. Write-before-send: a failure here throws (no send).
    await mapBounded(attachments, S3_CONCURRENCY, async (attachment, index) => {
      const copied = await this.uploads.copy(attachment.sourceKey, sentAttachmentKey(id, index));
      if (!copied) {
        throw emailErrors.invalidRequest(attachment.missing);
      }
    });
    // An upload's embedded bytes come from the upload itself: an MCP role without the read
    // tools can read its own uploads, but not the sent attachments. A forwarded file's come from
    // the copy just made — forwarding needs the read grants, and the copy can't vanish.
    const embed: RawMimeAttachment[] = await mapBounded(
      attachments
        .map((attachment, index) => ({ attachment, index }))
        .filter((entry) => entry.attachment.embed),
      S3_CONCURRENCY,
      async (entry) => ({
        filename: entry.attachment.filename,
        contentType: entry.attachment.contentType,
        contentBase64: (
          await this.uploads.getBytes(
            entry.attachment.forwarded
              ? sentAttachmentKey(id, entry.index)
              : entry.attachment.sourceKey,
          )
        ).toString('base64'),
      }),
    );
    const links = await this.mintDownloadLinks(attachments, id, nowDate, {
      sender: from.toLowerCase(),
      ownDomainRecipients: this.ownDomainRecipients(recipients),
    });
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
      subject,
      ...(replyTo.length > 0 ? { replyTo } : {}),
      ...(threadHeaders
        ? { inReplyTo: threadHeaders.inReplyTo, references: threadHeaders.references }
        : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.html !== undefined ? { html: body.html } : {}),
      attachments: embed,
    });
    if (raw.length > MAX_RAW_MESSAGE_BYTES) {
      throw emailErrors.invalidRequest('The assembled message exceeds the maximum size.');
    }

    const sentAt = nowDate.toISOString();
    const rawS3Key = sentRawKey(id);

    // Write-before-send (#29), FAIL-CLOSED: with the attachments already copied (above),
    // archive the EXACT composed MIME and the body (inline, or `bodies/sent/<id>.json`), then
    // record the attempt as `status:'sending'` — all BEFORE SES. A failure in any throws (no
    // send), so we never send a message we couldn't archive + record; the caller can retry with
    // a fresh id. Orphan objects from a later failure are harmless (RETAINed).
    await this.objectStore.put(rawS3Key, raw);
    const record: CreateSentEmailInput = {
      id,
      from,
      to,
      cc,
      bcc,
      subject,
      ...(replyTo.length > 0 ? { replyTo } : {}),
      ...(threadHeaders ? { references: threadHeaders.references } : {}),
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
    // Record the Message-ID SES gave it too, so a later reply threads on exactly what the
    // recipients saw even if this deployment's region changes.
    await this.recordTerminalStatus({
      id,
      sentAt,
      status: 'sent',
      sesMessageId: messageId,
      messageIdHeader: sesMessageIdHeader(messageId, this.sesRegion),
    });

    // The same opaque id the list and read surfaces use, so a caller can open what it just sent.
    return {
      id: encodeEmailRef(EmailEntity.sent(sentAt, id)),
      messageId,
      sentAt,
      ...(thread ? { threaded: threadHeaders !== undefined } : {}),
    };
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
   * failure leaves harmless orphans that expire with the token TTL. Each token also records
   * who sent the message and which of its recipients are this deployment's own addresses, so
   * the copy that comes back in through inbound can carry the file as a real attachment.
   */
  private async mintDownloadLinks(
    attachments: readonly ResolvedAttachment[],
    emailId: string,
    nowDate: Date,
    parties: TokenParties,
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
        sender: parties.sender,
        ...(parties.ownDomainRecipients.length > 0
          ? { ownDomainRecipients: parties.ownDomainRecipients }
          : {}),
      });
      links.push({
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        url: downloadUrl(this.downloadBaseUrl, token),
      });
    }
    return links;
  }

  /**
   * The recipients this deployment receives mail for — exactly the configured domain, as the
   * inbound receipt rule and MX cover (a subdomain address never comes back in) — lowercased and
   * de-duplicated. Kept as the list rather than a flag, so a token records who it was for.
   */
  private ownDomainRecipients(recipients: readonly string[]): string[] {
    const own = new Set<string>();
    for (const address of recipients) {
      const domain = normalizeDomain(address.slice(address.lastIndexOf('@') + 1));
      if (domain === this.emailDomain) {
        own.add(address.toLowerCase());
      }
    }
    return [...own];
  }

  /**
   * The message `handle` names, for a reply: its subject, and the threading headers —
   * `In-Reply-To` is its `Message-ID` (stored for received mail, derived from the SES id for our
   * own) and `References` extends its chain. A message without a usable id (received before ids
   * were recorded, or with a malformed one; a send SES never accepted) has no headers: the reply
   * still goes out, unthreaded, and the response says so. A handle that names nothing is the
   * caller's mistake, and an error.
   */
  private async resolveThread(handle: unknown): Promise<ReplyThread> {
    if (typeof handle !== 'string' || handle.length === 0) {
      throw emailErrors.invalidRequest('"inReplyTo" must be a message id from the mailbox list.');
    }
    if (!this.canReadMailbox) {
      throw emailErrors.invalidRequest(
        '"inReplyTo" needs receiving enabled on this deployment, to look up the original message.',
      );
    }
    let row;
    try {
      row = await this.emailsDao.getEmail(decodeEmailRef(handle));
    } catch (error) {
      if (error instanceof EmailError) {
        throw emailErrors.invalidRequest('"inReplyTo" is not a message id from the mailbox list.');
      }
      throw error;
    }
    if (row === null) {
      throw emailErrors.invalidRequest('"inReplyTo" names no message in the mailbox.');
    }
    // Received mail: its own header. Sent mail: the id recorded when SES accepted it, or — on a
    // row from before that was recorded — derived from the SES id the same way.
    const messageId =
      row.messageIdHeader ??
      (row.direction === 'sent' && row.sesMessageId !== undefined
        ? sesMessageIdHeader(row.sesMessageId, this.sesRegion)
        : undefined);
    if (messageId === undefined) {
      return { subject: row.subject };
    }
    return {
      subject: row.subject,
      headers: { inReplyTo: messageId, references: replyReferences(row.references, messageId) },
    };
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
   * Resolve each attachment reference to the file it names — an upload by what S3 says was
   * really uploaded (a HEAD — never the client's word), a forwarded attachment by what its
   * message's row recorded — and decide embed vs link, first fit in request order: a file is
   * embedded when it is at most `embedMaxBytes` and still fits the message's remaining
   * `embedTotalBytes` — so a small file after a linked one can still be embedded.
   */
  private async resolveAttachments(
    refs: SendEmailServiceRequest['attachments'],
  ): Promise<ResolvedAttachment[]> {
    if (refs === undefined || refs.length === 0) {
      return [];
    }
    if (!Array.isArray(refs) || refs.length > MAX_ATTACHMENTS) {
      throw emailErrors.invalidRequest(
        `A message may have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    const sources = refs.map((ref, index) => attachmentSource(ref, index));
    // Several files forwarded from one message read its row once.
    const rows = new Map<string, Promise<GetEmailOutput | null>>();
    const files = await mapBounded(sources, S3_CONCURRENCY, (source) =>
      source.kind === 'upload'
        ? this.resolveUpload(source.uploadId)
        : this.resolveStored(source, rows),
    );
    const resolved: ResolvedAttachment[] = [];
    let embeddedBytes = 0;
    for (const file of files) {
      const embed =
        file.sizeBytes <= this.embedMaxBytes &&
        embeddedBytes + file.sizeBytes <= this.embedTotalBytes;
      if (embed) {
        embeddedBytes += file.sizeBytes;
      }
      resolved.push({ ...file, embed });
    }
    return resolved;
  }

  /** A finished upload, as S3 reports it. */
  private async resolveUpload(uploadId: string): Promise<Omit<ResolvedAttachment, 'embed'>> {
    const missing = uploadNotFound(uploadId);
    const uploaded: UploadedObject | null = await this.uploads.head(uploadKey(uploadId));
    if (uploaded === null) {
      throw emailErrors.invalidRequest(missing);
    }
    if (uploaded.sizeBytes > MAX_UPLOAD_BYTES) {
      throw emailErrors.invalidRequest(`Attachment "${uploaded.filename}" is too large.`);
    }
    return {
      sourceKey: uploadKey(uploadId),
      missing,
      forwarded: false,
      filename: uploaded.filename,
      contentType: uploaded.contentType,
      sizeBytes: uploaded.sizeBytes,
    };
  }

  /**
   * An attachment of a message already in the mailbox, by its row's descriptor — only the
   * descriptors a message actually has are addressable, exactly as for a download: a received
   * message's only when its content was exposable (virus PASS, parsed), re-checked here. A
   * received message flagged as spam is refused too: forwarding sends its file out from this
   * domain in one call, which a hostile message's text could ask an agent to do.
   */
  private async resolveStored(
    source: StoredAttachmentRef & { readonly index: number },
    rows: Map<string, Promise<GetEmailOutput | null>>,
  ): Promise<Omit<ResolvedAttachment, 'embed'>> {
    const where = `"attachments[${source.index}]"`;
    if (!this.canReadMailbox) {
      throw emailErrors.invalidRequest(
        `${where}: forwarding a stored attachment needs receiving enabled on this deployment.`,
      );
    }
    let row: GetEmailOutput | null;
    try {
      const ref = decodeEmailRef(source.emailId);
      let lookup = rows.get(source.emailId);
      if (lookup === undefined) {
        lookup = this.emailsDao.getEmail(ref);
        rows.set(source.emailId, lookup);
      }
      row = await lookup;
    } catch (error) {
      if (error instanceof EmailError) {
        throw emailErrors.invalidRequest(
          `${where}: "emailId" is not a message id from the mailbox.`,
        );
      }
      throw error;
    }
    if (row === null) {
      throw emailErrors.invalidRequest(`${where}: "emailId" names no message in the mailbox.`);
    }
    if (row.direction === 'inbound') {
      const exposure = decideExposure(
        { spamVerdict: row.spamVerdict, virusVerdict: row.virusVerdict },
        row.parseStatus,
      );
      if (!exposure.exposeContent) {
        throw emailErrors.invalidRequest(`${where}: that message has no attachments to forward.`);
      }
      if (row.quarantined) {
        throw emailErrors.invalidRequest(
          `${where}: that message was flagged as spam, so its attachments are not forwarded. ` +
            'Download the file and attach it as an upload if you trust it.',
        );
      }
    }
    const descriptor = (
      row.direction === 'inbound' ? row.attachments : (row.attachments ?? [])
    ).find((candidate) => candidate.id === source.attachmentId);
    if (descriptor === undefined) {
      throw emailErrors.invalidRequest(`${where}: that message has no such attachment.`);
    }
    return {
      forwarded: true,
      sourceKey: descriptor.s3Key,
      missing: `${where}: "${descriptor.filename}" is no longer stored, so it cannot be forwarded.`,
      filename: descriptor.filename,
      contentType: descriptor.contentType,
      sizeBytes: descriptor.sizeBytes,
    };
  }
}

/** What a reply carries from the message it answers. */
interface ReplyThread {
  /** The original's subject — the default for the reply's own. */
  readonly subject: string;
  /** Absent when the original has no usable `Message-ID`: the reply goes out unthreaded. */
  readonly headers?: {
    readonly inReplyTo: string;
    readonly references: readonly string[];
  };
}

/** How many uploads a send HEADs, copies, or reads at once. */
const S3_CONCURRENCY = 5;

/** An upload that isn't there: never uploaded, or swept since. The client can upload again. */
function uploadNotFound(uploadId: string): string {
  return `Attachment upload "${uploadId}" was not found — it may never have been uploaded, or it expired. Upload it again.`;
}

/** One attachment reference, checked for shape: an upload, or a stored message's attachment. */
type AttachmentSource =
  | { readonly kind: 'upload'; readonly uploadId: string }
  | (StoredAttachmentRef & { readonly kind: 'stored'; readonly index: number });

function attachmentSource(ref: unknown, index: number): AttachmentSource {
  const record = (typeof ref === 'object' && ref !== null ? ref : {}) as Record<string, unknown>;
  if ('uploadId' in record) {
    if (!isValidUploadId(record.uploadId)) {
      throw emailErrors.invalidRequest(
        `"attachments[${index}].uploadId" must be the id of an attachment upload.`,
      );
    }
    return { kind: 'upload', uploadId: record.uploadId };
  }
  if (
    typeof record.emailId === 'string' &&
    record.emailId.length > 0 &&
    typeof record.attachmentId === 'string' &&
    record.attachmentId.length > 0
  ) {
    return {
      kind: 'stored',
      index,
      emailId: record.emailId,
      attachmentId: record.attachmentId,
    };
  }
  throw emailErrors.invalidRequest(
    `"attachments[${index}]" must be { "uploadId" } or { "emailId", "attachmentId" }.`,
  );
}

/** Who a sent message's download tokens record: its sender and its own-domain recipients. */
interface TokenParties {
  readonly sender: string;
  readonly ownDomainRecipients: readonly string[];
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
