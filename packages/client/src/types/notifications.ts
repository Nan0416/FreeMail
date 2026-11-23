/**
 * What FreeMail publishes to its email-received SNS topic, as the service declares it in
 * `packages/shared/src/service-api.ts`. A copy, checked by `tests/shared-types.typecheck.ts`.
 */
import type { InboundVerdict } from './service.js';

export const EMAIL_RECEIVED_TYPE = 'email.received';
/** Raised only for a breaking change to the notification. */
export const EMAIL_RECEIVED_VERSION = 1;

/**
 * Published for each received message stored with its content: indexed, flagged as spam, or a redelivery of either.
 * Metadata only; `getEmail` returns the message. Delivery is at least once, so de-duplicate on `id`.
 */
export interface EmailReceivedNotification {
  readonly version: typeof EMAIL_RECEIVED_VERSION;
  readonly type: typeof EMAIL_RECEIVED_TYPE;
  /** The id for `getEmail`, the same on every delivery. */
  readonly id: string;
  /** The server's receipt time, ISO-8601 UTC. */
  readonly receivedAt: string;
  /** The sender's address. Set by the sender: never use it for authorization. */
  readonly from: string;
  readonly fromName?: string;
  /** Header recipients, at most 50 each. A BCC'd recipient is not listed. */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** Present when `to` or `cc` was cut to 50. */
  readonly recipientsTruncated?: true;
  /** At most 1,000 characters. */
  readonly subject: string;
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** The raw message's size in bytes. */
  readonly sizeBytes: number;
  /** SES flagged it as spam. */
  readonly spam: boolean;
  readonly spamVerdict: InboundVerdict;
}
