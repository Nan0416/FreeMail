/**
 * Wire contract for sending email, shared by the service (which sends), the MCP
 * `send_email` tool (#7, a thin wrapper over the same service), and the React app
 * (compose/send). One request shape carries the message; the service validates it.
 *
 * Small attachments are embedded in the MIME as base64 (SES SendRawEmail). The
 * binding size ceiling is API Gateway's 10 MB request-body limit — base64 inflates
 * bytes ~1.37×, so the decoded-attachment cap is kept well under that (anything
 * larger is the Phase-3 large-attachment token flow, #14). SES itself caps a
 * message at 40 MB.
 */

/** An attachment embedded in the outgoing message. `contentBase64` is the raw bytes, base64-encoded. */
export interface EmailAttachment {
  /** File name shown to the recipient. */
  filename: string;
  /** MIME content type, e.g. `application/pdf`. */
  contentType: string;
  /** Attachment bytes, base64-encoded. */
  contentBase64: string;
}

/**
 * A request to send one email. `from` must be an address under the deployment's
 * configured domain. At least one recipient (across to/cc/bcc) and at least one
 * body part (text or html) are required — enforced in the service so REST and MCP
 * share identical rules.
 */
export interface SendEmailRequest {
  /** Sender address — must be under the configured email domain. */
  from: string;
  /** Optional display name for the sender (`Name <addr>`). */
  fromName?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  /** Plain-text body. At least one of `text` / `html` is required. */
  text?: string;
  /** HTML body. At least one of `text` / `html` is required. */
  html?: string;
  attachments?: EmailAttachment[];
}

/** Result of a successful send. */
export interface SendEmailResponse {
  /** FreeMail's own id for the sent message (keys the metadata row). */
  id: string;
  /** The message id SES assigned. */
  messageId: string;
  /** Send time, ISO-8601. */
  sentAt: string;
}

/**
 * Max total size of all attachments (decoded bytes). Deliberately below API
 * Gateway's 10 MB request-body limit once base64-inflated (~1.37×) — a larger
 * payload can't reach the Lambda through the JSON path anyway.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024;

/** Max number of attachments on one message. */
export const MAX_ATTACHMENTS = 20;

/** Max recipients across to + cc + bcc — SES's per-message destination limit. */
export const MAX_RECIPIENTS = 50;

/** Hard upper bound on the assembled raw MIME message — SES rejects anything larger. */
export const MAX_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

export type EmailErrorCode = 'invalid_request' | 'invalid_sender';

export interface EmailErrorBody {
  error: EmailErrorCode;
  message: string;
}

/**
 * A pragmatic address check: a non-empty local part, an `@`, and a dotted domain,
 * with no whitespace. Not full RFC 5322 — SES is the final authority — but enough
 * to reject obvious garbage at the boundary with a clear 400 instead of a 500.
 */
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: string): boolean {
  return typeof value === 'string' && EMAIL_ADDRESS_RE.test(value);
}
