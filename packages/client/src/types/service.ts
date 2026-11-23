/**
 * The FreeMail API an API key can call, as the service declares it in `packages/shared/src/email.ts`
 * and `service-api.ts`. `@freemail/shared` is not published, so these are copies;
 * `tests/shared-types.typecheck.ts` fails the build when the two drift apart.
 */

/** An attachment to send: a finished upload, or a file already stored on a message. */
export type EmailAttachmentRef = UploadAttachmentRef | StoredAttachmentRef;

/** A finished upload, referenced by the id its upload returned. */
export interface UploadAttachmentRef {
  readonly uploadId: string;
}

/** An attachment of a message already in the mailbox, received or sent, to forward as is. The server copies the file. */
export interface StoredAttachmentRef {
  /** The message's id, as `getEmail` and the email-received notification give it. */
  readonly emailId: string;
  /** The attachment's id from that message's `attachments`. */
  readonly attachmentId: string;
}

/** `POST /attachments/uploads`: ask for a presigned URL to upload one attachment straight to S3. */
export interface CreateAttachmentUploadRequest {
  /** The file name the recipient sees. */
  readonly filename: string;
  /** MIME type, such as `application/pdf`; `application/octet-stream` when omitted. */
  readonly contentType?: string;
  /** The file's exact size in bytes. The upload must be exactly this long. */
  readonly sizeBytes: number;
}

export interface CreateAttachmentUploadResponse {
  /** Put this in `SendEmailRequest.attachments` once the PUT has succeeded. */
  readonly uploadId: string;
  /** A presigned S3 URL: PUT the file's bytes here, with no API key. */
  readonly uploadUrl: string;
  readonly uploadMethod: 'PUT';
  /** When the URL stops accepting the upload, ISO-8601 (15 minutes after it was created). */
  readonly expiresAt: string;
}

/**
 * `POST /emails`: send one email. `from` must be an address under the deployment's domain. At least one recipient
 * (across `to`, `cc` and `bcc`) and at least one body (`text` or `html`) are required.
 */
export interface SendEmailRequest {
  readonly from: string;
  /** The sender's display name (`Name <address>`). */
  readonly fromName?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  /** Finished uploads, or stored attachments to forward, in order. At most 20. */
  readonly attachments?: readonly EmailAttachmentRef[];
  /**
   * The id of the message this one answers. The send sets `In-Reply-To` and `References` from it, and an omitted
   * `subject` becomes `Re: <its subject>`. The recipients are still the ones given here.
   */
  readonly inReplyTo?: string;
  /** `Reply-To` addresses: where replies should go, if not `from`. */
  readonly replyTo?: readonly string[];
  /**
   * Makes a retry safe: for 24 hours, the same request with the same key returns the first send's response
   * (`replayed: true`) instead of sending again. 1–128 letters, digits and `._:-`. The same key on a different request
   * is refused.
   */
  readonly idempotencyKey?: string;
}

export interface SendEmailResponse {
  /** The sent message's id, for `getEmail`. */
  readonly id: string;
  /** The message id SES assigned. */
  readonly messageId: string;
  /** ISO-8601. */
  readonly sentAt: string;
  /** Present when the send named `inReplyTo`: false when the original had no usable `Message-ID`, so the reply went out unthreaded. */
  readonly threaded?: boolean;
  /** True when an earlier send with the same `idempotencyKey` produced this response. */
  readonly replayed?: boolean;
}

export type EmailDirection = 'sent' | 'inbound';

/** Sent mail only: where the send has got to. */
export type SentStatus = 'sending' | 'sent' | 'delivered' | 'bounced' | 'send_failed';

/** Sent mail only: one report SES sent after accepting the message. */
export interface DeliveryEvent {
  readonly type: 'delivered' | 'bounced' | 'complained' | 'delayed' | 'rejected';
  /** ISO-8601 UTC. */
  readonly at: string;
  /** The recipients it is about; empty when SES names none. */
  readonly recipients: readonly string[];
  /** SES's classification of a bounce, delay, complaint or reject. */
  readonly detail?: string;
}

/** An SES scan verdict on received mail. Only `PASS` is clean. */
export type InboundVerdict = 'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED' | 'CONFLICTING' | 'ABSENT' | 'UNKNOWN';

/** How parsing a received message went. */
export type InboundParseStatus = 'ok' | 'oversize' | 'limit_exceeded' | 'parse_failed';

export interface ServiceEmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** A presigned S3 download, valid until `downloadUrlExpiresAt` (5 minutes). Call `getEmail` again for a fresh one. */
  readonly downloadUrl: string;
  /** ISO-8601 UTC. */
  readonly downloadUrlExpiresAt: string;
}

/** `GET /api/emails/{id}`: one message, with a download URL on every attachment. */
export interface ServiceEmailDetail {
  readonly id: string;
  readonly direction: EmailDirection;
  /** The sender's address as the message's header wrote it. Set by the sender: not proof of who sent it. */
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** Sent mail only. */
  readonly bcc?: readonly string[];
  readonly replyTo?: readonly string[];
  readonly subject: string;
  /** Sent: the send time. Received: the server's receipt time. ISO-8601 UTC. */
  readonly date: string;
  readonly status?: SentStatus;
  readonly deliveryEvents?: readonly DeliveryEvent[];
  /** Received mail: the message's own `Date:` header, set by the sender. */
  readonly headerDate?: string;
  /** The plain-text body; absent when there is none or the content was withheld. */
  readonly text?: string;
  /** The HTML body, raw and unsanitized: sanitize it before rendering. */
  readonly html?: string;
  /** A body part reached the read cap and was cut. */
  readonly bodyTruncated?: boolean;
  readonly attachments: readonly ServiceEmailAttachment[];
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** Received mail hidden by default: content withheld, or flagged as spam. */
  readonly quarantined?: boolean;
  readonly spamVerdict?: InboundVerdict;
  readonly virusVerdict?: InboundVerdict;
  readonly parseStatus?: InboundParseStatus;
  /** Received mail whose content could not be extracted. */
  readonly failed?: boolean;
  /** The raw message's size in bytes. */
  readonly sizeBytes: number;
}

export interface GetEmailRequest {
  /** The message's id: `id` from the email-received notification, or from `sendEmail`'s response. */
  readonly id: string;
}

/** `uploadAttachment`: create an upload and PUT the bytes in one call. */
export interface UploadAttachmentRequest {
  readonly filename: string;
  /** MIME type; `application/octet-stream` when omitted. */
  readonly contentType?: string;
  /** The file's bytes (a Node.js `Buffer` is a `Uint8Array`). At most 100 MB. */
  readonly content: Uint8Array;
}

/** Per-call options. */
export interface FreeMailRequestOptions {
  /** Aborts the call. */
  readonly signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call (for `uploadAttachment`, both of its requests). */
  readonly timeoutMs?: number;
}

export interface FreeMailClient {
  /** `POST /emails`. Mail really goes out. Pass an `idempotencyKey` to make a retry safe. */
  sendEmail(request: SendEmailRequest, options?: FreeMailRequestOptions): Promise<SendEmailResponse>;
  /** `POST /attachments/uploads`. PUT the bytes to `uploadUrl` yourself, or use `uploadAttachment`. */
  createAttachmentUpload(request: CreateAttachmentUploadRequest, options?: FreeMailRequestOptions): Promise<CreateAttachmentUploadResponse>;
  /** Creates an upload and PUTs `content` to it; pass the result in `SendEmailRequest.attachments`. */
  uploadAttachment(request: UploadAttachmentRequest, options?: FreeMailRequestOptions): Promise<UploadAttachmentRef>;
  /** `GET /api/emails/{id}`. An id the deployment does not hold throws `FreeMailEmailNotFoundError`. */
  getEmail(request: GetEmailRequest, options?: FreeMailRequestOptions): Promise<ServiceEmailDetail>;
}
