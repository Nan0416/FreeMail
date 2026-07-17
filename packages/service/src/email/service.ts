/**
 * Send-email orchestration — the single place send logic lives, so the REST route
 * and the MCP `send_email` tool (#7) are both thin wrappers over the SAME
 * validation + send + record flow. All I/O (SES, DynamoDB, the MIME builder) is
 * injected, so every branch is unit-testable without AWS.
 *
 * Validation is deliberately here (not in the handler): the sender-domain check
 * and payload caps must hold for every caller, REST or MCP.
 */
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_RAW_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  isSubdomainOrEqual,
  isValidEmailAddress,
  normalizeDomain,
  type SendEmailRequest,
  type SendEmailResponse,
} from '@freemail/shared';
import type { EmailsRepo } from '../data/emails-repo.js';
import { emailErrors } from './errors.js';
import { buildRawMime, type RawMimeAttachment, type RawMimeInput } from './mime.js';
import type { SesSender } from './ses-sender.js';

export interface EmailServiceDeps {
  ses: SesSender;
  emails: EmailsRepo;
  /** The domain every `from` must be under (the configured send domain). */
  emailDomain: string;
  /** MIME builder; injectable so service tests don't depend on the MIME library. */
  buildMime?: (input: RawMimeInput) => Promise<Buffer>;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Id generator, injectable for tests. */
  generateId?: () => string;
}

export class EmailService {
  private readonly ses: SesSender;
  private readonly emails: EmailsRepo;
  private readonly emailDomain: string;
  private readonly buildMime: (input: RawMimeInput) => Promise<Buffer>;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: EmailServiceDeps) {
    this.ses = deps.ses;
    this.emails = deps.emails;
    this.emailDomain = normalizeDomain(deps.emailDomain);
    this.buildMime = deps.buildMime ?? buildRawMime;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
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

    const attachments = this.validateAttachments(request.attachments);

    const raw = await this.buildMime({
      from,
      ...(fromName !== undefined ? { fromName } : {}),
      to,
      cc,
      bcc,
      subject: request.subject ?? '',
      ...(text !== undefined ? { text } : {}),
      ...(html !== undefined ? { html } : {}),
      attachments,
    });
    if (raw.length > MAX_RAW_MESSAGE_BYTES) {
      throw emailErrors.invalidRequest('The assembled message exceeds the maximum size.');
    }

    // Allocate the id before sending so the sent mail and its (best-effort)
    // metadata row correlate even if the record write later fails.
    const id = this.generateId();
    const { messageId } = await this.ses.send({ from, to, cc, bcc, raw });
    const sentAt = this.now().toISOString();

    // Best-effort: the mail is already out, so a metadata write failure must not
    // fail the response — history is a convenience, delivery is the contract.
    try {
      await this.emails.putSent({
        id,
        from,
        to,
        cc,
        bcc,
        subject: request.subject ?? '',
        sesMessageId: messageId,
        sentAt,
        attachmentCount: attachments.length,
        sizeBytes: raw.length,
      });
    } catch (error) {
      // Error level so a systematic loss of history rows is alarmable; include the
      // correlating ids so the sent mail can be reconciled from SES logs.
      console.error(
        'Failed to record sent-email metadata',
        { emailId: id, sesMessageId: messageId },
        error,
      );
    }

    return { id, messageId, sentAt };
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

  private validateAttachments(attachments: SendEmailRequest['attachments']): RawMimeAttachment[] {
    if (attachments === undefined || attachments.length === 0) {
      return [];
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      throw emailErrors.invalidRequest(
        `A message may have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    }
    let totalBytes = 0;
    const normalized: RawMimeAttachment[] = [];
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
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw emailErrors.invalidRequest(
          `Total attachment size exceeds ${MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
        );
      }
      normalized.push({ filename, contentType, contentBase64 });
    }
    return normalized;
  }
}

/** Trim, drop empty strings; leaves address case untouched (local parts are case-sensitive). */
function normalizeRecipients(list: string[] | undefined): string[] {
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
