/**
 * Contracts for other backend services: the email-received SNS notification, and the
 * IAM-authorized `GET /api/emails/{id}` response.
 */
import type { EmailAttachmentInfo, EmailDetail, InboundVerdict } from './email.js';

export const EMAIL_RECEIVED_TYPE = 'email.received';
/** Bumped only on a breaking change to {@link EmailReceivedNotification}. */
export const EMAIL_RECEIVED_VERSION = 1;
/** Caps that keep a notification far below SNS's 256 KB message limit. */
export const NOTIFICATION_MAX_RECIPIENTS = 50;
export const NOTIFICATION_MAX_SUBJECT_CHARS = 1000;

/**
 * Published to the email-received topic each time a received message is stored with its
 * content: indexed, spam-flagged, or a redelivery of either. Metadata only; fetch the message
 * with `GET /api/emails/{id}`. Delivery is at-least-once: de-duplicate on `id`.
 */
export interface EmailReceivedNotification {
  readonly version: typeof EMAIL_RECEIVED_VERSION;
  readonly type: typeof EMAIL_RECEIVED_TYPE;
  /** Handle for `GET /api/emails/{id}`. Stable across redeliveries. */
  readonly id: string;
  /** Server receipt time, ISO-8601 UTC. */
  readonly receivedAt: string;
  /** Sender address. Attacker-controlled: never use it for authorization. */
  readonly from: string;
  readonly fromName?: string;
  /** Header recipients, at most {@link NOTIFICATION_MAX_RECIPIENTS} each. BCC'd recipients aren't listed. */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /**
   * Present when `to` or `cc` was cut to the cap. The stored message keeps at most 50 addresses
   * per header as well, so today this never appears; it guards a future higher storage cap.
   */
  readonly recipientsTruncated?: true;
  /** At most {@link NOTIFICATION_MAX_SUBJECT_CHARS} characters. */
  readonly subject: string;
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** Raw message size in bytes. */
  readonly sizeBytes: number;
  /** SES flagged it as spam; the web app hides it by default. */
  readonly spam: boolean;
  readonly spamVerdict: InboundVerdict;
}

/** How long the download URLs in `GET /api/emails/{id}` stay valid. */
export const SERVICE_ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

/** An attachment with a presigned download URL. Fetch the message again once it expires. */
export interface ServiceEmailAttachment extends EmailAttachmentInfo {
  readonly downloadUrl: string;
  /** ISO-8601 UTC. */
  readonly downloadUrlExpiresAt: string;
}

/** `GET /api/emails/{id}`: the web app's detail without the `.eml` fields, plus download URLs. */
export interface ServiceEmailDetail extends Omit<EmailDetail, 'attachments' | 'rawAvailable' | 'rawSuspicious'> {
  readonly attachments: readonly ServiceEmailAttachment[];
}
