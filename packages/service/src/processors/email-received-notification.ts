import { EMAIL_RECEIVED_TYPE, EMAIL_RECEIVED_VERSION, NOTIFICATION_MAX_RECIPIENTS, NOTIFICATION_MAX_SUBJECT_CHARS, type EmailReceivedNotification } from '@freemail/shared';
import type { CreateInboundEmailInput } from '../data/emails-dao.js';
import { EmailEntity } from '../data/entities.js';
import { encodeEmailRef } from '../utils/email-ref.js';

/** Publishes {@link EmailReceivedNotification}s (SNS in production). */
export interface EmailReceivedNotifier {
  emailReceived(notification: EmailReceivedNotification): Promise<void>;
}

/**
 * The notification for a stored message whose content was kept. Only such rows live in the
 * INBOUND partition, so the `id` is the same handle the list API mints for the row.
 */
export function buildEmailReceivedNotification(record: CreateInboundEmailInput): EmailReceivedNotification {
  const to = record.to.slice(0, NOTIFICATION_MAX_RECIPIENTS);
  const cc = record.cc.slice(0, NOTIFICATION_MAX_RECIPIENTS);
  const truncated = to.length < record.to.length || cc.length < record.cc.length;
  return {
    version: EMAIL_RECEIVED_VERSION,
    type: EMAIL_RECEIVED_TYPE,
    id: encodeEmailRef(EmailEntity.inbound(record.receivedAt, record.id, false)),
    receivedAt: record.receivedAt,
    from: record.from,
    ...(record.fromName ? { fromName: record.fromName } : {}),
    to,
    cc,
    ...(truncated ? { recipientsTruncated: true as const } : {}),
    subject: record.subject.slice(0, NOTIFICATION_MAX_SUBJECT_CHARS),
    hasAttachments: record.hasAttachments,
    attachmentCount: record.attachmentCount,
    sizeBytes: record.sizeBytes,
    spam: record.quarantined,
    spamVerdict: record.spamVerdict,
  };
}
