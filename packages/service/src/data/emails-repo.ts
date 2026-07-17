/**
 * Persistence port for sent-email metadata. Kept an interface so the
 * {@link EmailService} is testable with a fake and so the read slice (Phase 2)
 * can extend the same store without the service knowing about DynamoDB.
 */

/** Metadata for one sent message — headers + SES id, never the body/attachment bytes. */
export interface SentEmailRecord {
  /** FreeMail's own id for the message. */
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The message id SES assigned. */
  sesMessageId: string;
  /** Send time, ISO-8601. */
  sentAt: string;
  attachmentCount: number;
  /** Size of the raw MIME message in bytes. */
  sizeBytes: number;
}

export interface EmailsRepo {
  /** Record a sent message for later list/history. */
  putSent(record: SentEmailRecord): Promise<void>;
}
