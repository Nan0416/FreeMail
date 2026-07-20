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
  readonly filename: string;
  /** MIME content type, e.g. `application/pdf`. */
  readonly contentType: string;
  /** Attachment bytes, base64-encoded. */
  readonly contentBase64: string;
}

/**
 * A request to send one email. `from` must be an address under the deployment's
 * configured domain. At least one recipient (across to/cc/bcc) and at least one
 * body part (text or html) are required — enforced in the service so REST and MCP
 * share identical rules.
 */
export interface SendEmailRequest {
  /** Sender address — must be under the configured email domain. */
  readonly from: string;
  /** Optional display name for the sender (`Name <addr>`). */
  readonly fromName?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  /** Plain-text body. At least one of `text` / `html` is required. */
  readonly text?: string;
  /** HTML body. At least one of `text` / `html` is required. */
  readonly html?: string;
  readonly attachments?: readonly EmailAttachment[];
}

/** Result of a successful send. */
export interface SendEmailResponse {
  /** FreeMail's own id for the sent message (keys the metadata row). */
  readonly id: string;
  /** The message id SES assigned. */
  readonly messageId: string;
  /** Send time, ISO-8601. */
  readonly sentAt: string;
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

/**
 * Embed-vs-link boundary for outbound attachments (#14). An attachment whose decoded
 * size is at most this many bytes is embedded in the MIME (SES serves it); anything
 * LARGER is uploaded to S3 and delivered as a `GET /d/{token}` download link, so the
 * recipient's provider isn't asked to accept a bloated message. Kept under
 * {@link MAX_ATTACHMENT_TOTAL_BYTES} — the whole request (link + embedded bytes) still
 * arrives base64 in one JSON body, so API Gateway's 10 MB limit remains the hard ceiling.
 */
export const MAX_EMBED_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * How long an outbound large-attachment download link stays valid. Server-authoritative:
 * enforced on every claim of the token (DynamoDB TTL only garbage-collects the row later).
 */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Lifetime of the presigned S3 GET the `/d/{token}` redirect points at — short, per click. */
export const DOWNLOAD_PRESIGN_TTL_SECONDS = 60;

export type EmailErrorCode = 'invalid_request' | 'invalid_sender' | 'not_found';

export interface EmailErrorBody {
  readonly error: EmailErrorCode;
  readonly message: string;
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

/* ------------------------------------------------------------------ *
 * Read API (#11): list/read the mailbox + attachment download.
 *
 * The stored index has two partitions — sent (`pk='SENT'`) and received
 * (`pk='INBOUND'`) — merged into one newest-first timeline. Every message is
 * addressed by an OPAQUE `id` handle (minted by the list, echoed on read); the
 * client never constructs it and the raw S3 key never appears on the wire. Bodies
 * for received mail are materialized on demand from the raw MIME; sent mail carries
 * no stored body in v1, so its detail is envelope-only.
 * ------------------------------------------------------------------ */

/** Which partition a stored message came from. */
export type EmailDirection = 'sent' | 'inbound';

/**
 * Delivery status of a sent message (present on `sent` rows only). Set write-before-send:
 * `sending` the instant the message is archived + recorded, then `sent` once SES accepts it
 * (a `sesMessageId` exists) or `send_failed` if SES rejects it — so a failed send is visible
 * in the mailbox instead of vanishing. Absent on inbound rows (and on any legacy sent row
 * written before this field existed).
 */
export type SentStatus = 'sending' | 'sent' | 'send_failed';

/**
 * A normalized SES scan verdict on a received message. `PASS` is the only
 * affirmative-clean value; everything else (missing/injected/unknown header, or an
 * explicit fail) is fail-closed. Present on inbound rows only.
 */
export type InboundVerdict =
  'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED' | 'CONFLICTING' | 'ABSENT' | 'UNKNOWN';

/** Outcome of parsing a received message's raw MIME. Present on inbound rows only. */
export type InboundParseStatus = 'ok' | 'oversize' | 'limit_exceeded' | 'parse_failed';

/**
 * A public attachment descriptor. The `id` (the MIME part index) addresses the
 * download endpoint — the underlying S3 key is server-side only and never exposed.
 */
export interface EmailAttachmentInfo {
  /** Stable per-message attachment id; pass to `GET /emails/{id}/attachments/{attachmentId}`. */
  readonly id: string;
  /** Display filename (sanitized). */
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** One row of the merged timeline — envelope + preview, never the full body. */
export interface EmailListItem {
  /** Opaque handle addressing this message; pass to `GET /emails/{id}`. */
  readonly id: string;
  readonly direction: EmailDirection;
  readonly from: string;
  /** Sender display name, if any (inbound). */
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** Short plain-text preview — present only when content is exposable. */
  readonly snippet?: string;
  /** Timeline sort time, ISO-8601 UTC (sent → send time, inbound → server receipt time). */
  readonly date: string;
  /** Sent only: delivery status (`sending`/`sent`/`send_failed`). Absent on inbound + legacy rows. */
  readonly status?: SentStatus;
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** Inbound only: hidden-by-default (content suppressed OR spam-flagged). Absent on sent. */
  readonly quarantined?: boolean;
  /** Inbound only: SES verdicts, so the UI can explain a quarantine. Absent on sent. */
  readonly spamVerdict?: InboundVerdict;
  readonly virusVerdict?: InboundVerdict;
}

/** A single message with headers, body (received-only), and attachment list. */
export interface EmailDetail {
  /** Opaque handle (echoes the request). */
  readonly id: string;
  readonly direction: EmailDirection;
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** Sent messages only (bcc is never retained for received mail). */
  readonly bcc?: readonly string[];
  readonly subject: string;
  /** Timeline sort time, ISO-8601 UTC. */
  readonly date: string;
  /** Sent only: delivery status (`sending`/`sent`/`send_failed`). Absent on inbound + legacy rows. */
  readonly status?: SentStatus;
  /** Inbound only: the message's own `Date:` header (attacker-controlled), if present. */
  readonly headerDate?: string;
  /** Plain-text body — present only for an exposable received message. */
  readonly text?: string;
  /**
   * HTML body, returned RAW as data. The client MUST sandbox + sanitize before
   * rendering (a sandboxed iframe with no `allow-same-origin`) — the API never
   * renders it. Present only for an exposable received message.
   */
  readonly html?: string;
  /** True when a body part hit the read-size cap and was truncated. */
  readonly bodyTruncated?: boolean;
  readonly attachments: readonly EmailAttachmentInfo[];
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** Inbound only. */
  readonly quarantined?: boolean;
  readonly spamVerdict?: InboundVerdict;
  readonly virusVerdict?: InboundVerdict;
  readonly parseStatus?: InboundParseStatus;
  /** Raw message size in bytes. */
  readonly sizeBytes: number;
}

/** Paginated timeline page. `nextCursor` absent → no more results. */
export interface ListEmailsResponse {
  readonly emails: readonly EmailListItem[];
  /** Opaque continuation token — pass back as `?cursor=`. */
  readonly nextCursor?: string;
}

/** A short-lived presigned download URL for one attachment. */
export interface AttachmentDownloadResponse {
  /** Presigned S3 GET URL; downloads (never renders inline) and expires quickly. */
  readonly url: string;
  /** When the URL stops working, ISO-8601. */
  readonly expiresAt: string;
}

/** Default page size for `GET /emails` when `?limit=` is omitted. */
export const DEFAULT_EMAIL_PAGE_SIZE = 25;

/** Hard cap on `?limit=` for `GET /emails`. */
export const MAX_EMAIL_PAGE_SIZE = 100;

/** How long a presigned attachment URL stays valid — short, since it's minted per click. */
export const ATTACHMENT_URL_TTL_SECONDS = 60;

/**
 * Per-body-part raw UTF-8 byte cap for the reader. Received bodies are materialized from
 * raw MIME on demand; each part (text / html) is truncated to this many bytes. A larger
 * body is truncated (`bodyTruncated: true`); the raw message is always retained in S3.
 */
export const MAX_READ_BODY_BYTES = 1024 * 1024;

/**
 * Hard ceiling on the JSON-escaped bytes of a whole `GET /emails/{id}` response — the
 * envelope + the `{text, html}` body combined. JSON escaping can inflate a hostile body
 * (control chars → `\uXXXX`, i.e. 6×), so the body is fitted into `ceiling − envelope`
 * bytes, keeping the whole response comfortably under the ~6 MB Lambda / API Gateway
 * proxy response limit (≈1 MB of headroom).
 */
export const MAX_EMAIL_RESPONSE_BYTES = 5 * 1024 * 1024;
