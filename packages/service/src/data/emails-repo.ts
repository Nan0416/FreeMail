/**
 * Persistence port for email metadata. Kept an interface so the {@link EmailService}
 * (sent side) and the inbound processor are testable with a fake, and so the read
 * slice (#11) can extend the same store without either knowing about DynamoDB.
 *
 * Both directions share one table: sent messages under `pk='SENT'`, received under
 * `pk='INBOUND'`, each `sk='<iso>#<id>'` so the read slice lists either partition
 * newest-first and merges them into one timeline.
 */

/** Partition holding sent messages. */
export const SENT_PARTITION = 'SENT';
/** Partition holding received messages. */
export const INBOUND_PARTITION = 'INBOUND';

/** The two (and only) valid partitions — used to validate a decoded message handle. */
export const EMAIL_PARTITIONS: ReadonlySet<string> = new Set([SENT_PARTITION, INBOUND_PARTITION]);

/** Metadata for one sent message — headers + SES id, never the body/attachment bytes. */
export interface SentEmailRecord {
  /** FreeMail's own id for the message. */
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  /** The message id SES assigned. */
  readonly sesMessageId: string;
  /** Send time, ISO-8601. */
  readonly sentAt: string;
  readonly attachmentCount: number;
  /** Size of the raw MIME message in bytes. */
  readonly sizeBytes: number;
}

/**
 * SES scan verdicts, normalized. `PASS` is the ONLY affirmative-clean value —
 * `ABSENT` (no verdict header), `CONFLICTING` (duplicate/injected verdict lines),
 * and `UNKNOWN` (unrecognized value) are all fail-closed alongside `FAIL` / `GRAY`
 * / `PROCESSING_FAILED`. Attachments and the snippet are exposed only on `PASS`.
 */
export type InboundVerdict =
  'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED' | 'CONFLICTING' | 'ABSENT' | 'UNKNOWN';

/** Outcome of parsing the raw MIME. Only `ok` is a fully-processed message. */
export type InboundParseStatus = 'ok' | 'oversize' | 'limit_exceeded' | 'parse_failed';

/**
 * A descriptor for one extracted attachment. `s3Key` is server-side only — the read
 * API (#11) presigns it but never returns the raw key to the client. `filename` is
 * the attacker-supplied name kept for display/`Content-Disposition`; it is NOT part
 * of the (opaque) S3 key.
 */
export interface InboundAttachmentDescriptor {
  /** Stable per-message id (the MIME part index). */
  readonly id: string;
  /** Original, sanitized filename — metadata only, never used in the S3 key. */
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Server-side S3 pointer (`attachments/inbound/<id>/<partIndex>`). Never exposed by the read API. */
  readonly s3Key: string;
}

/** Metadata for one received message. Attachments + snippet are present only when content is exposable. */
export interface InboundEmailRecord {
  /** FreeMail's id for the message — the validated SES message id (stable → idempotent). */
  readonly id: string;
  /** Same value as `id`; kept explicit to mirror the sent-side field. */
  readonly sesMessageId: string;
  /** First `From` address, sanitized. */
  readonly from: string;
  /** `From` display name, sanitized, if present. */
  readonly fromName?: string;
  /** `To` addresses, sanitized + count-capped. */
  readonly to: readonly string[];
  /** `Cc` addresses, sanitized + count-capped. */
  readonly cc: readonly string[];
  /** Subject, sanitized + length-capped (`''` if absent). */
  readonly subject: string;
  /** Short plain-text preview — present ONLY when content is exposable (parsed + virus `PASS`). */
  readonly snippet?: string;
  /** Server-trusted receipt time (S3 object `LastModified`), ISO-8601 — the sort-key basis. */
  readonly receivedAt: string;
  /** The message's own `Date:` header, ISO-8601 — display-only, attacker-controlled, may be absent. */
  readonly headerDate?: string;
  readonly hasAttachments: boolean;
  readonly attachmentCount: number;
  /** Extracted attachments — empty unless content is exposable. */
  readonly attachments: readonly InboundAttachmentDescriptor[];
  readonly spamVerdict: InboundVerdict;
  readonly virusVerdict: InboundVerdict;
  readonly parseStatus: InboundParseStatus;
  /** Hidden-by-default: content suppressed (not virus-`PASS`/parse-failed) OR spam-flagged. */
  readonly quarantined: boolean;
  /** S3 pointer to the raw MIME kept as the forensic source of truth (`inbound/<id>`). */
  readonly rawS3Key: string;
  /** Raw MIME size in bytes (from S3 `HeadObject`). */
  readonly sizeBytes: number;
}

export interface EmailsRepo {
  /** Record a sent message for later list/history. */
  putSent(record: SentEmailRecord): Promise<void>;
  /**
   * Record a received message. The write is conditional on the id not already
   * existing, so an at-least-once redelivery is a no-op rather than a double-write —
   * resolves to `false` when the row already existed, `true` when this call wrote it.
   */
  putInbound(record: InboundEmailRecord): Promise<boolean>;
}

/**
 * A stored row plus its DynamoDB sort key. The read slice (#11) needs `sk` to mint the
 * opaque message handle and the pagination cursor — both derive from `{ pk, sk }`, never
 * from a client-supplied key.
 */
export type StoredEmailRow =
  | ({ readonly direction: 'sent'; readonly sk: string } & SentEmailRecord)
  | ({ readonly direction: 'inbound'; readonly sk: string } & InboundEmailRecord);

/**
 * Read-side queries over the same two-partition table. Kept a separate interface so the
 * read service and #13's MCP read tools depend only on the reads, and so it's testable
 * against a fake without DynamoDB.
 */
export interface EmailsReadRepo {
  /**
   * One partition (`'sent'` → `pk='SENT'`, `'inbound'` → `pk='INBOUND'`), newest-first,
   * at most `limit` rows strictly older than `afterSk` (omit `afterSk` to start from the
   * newest). Fewer than `limit` rows returned means the partition is exhausted past that
   * point — the read service uses that to decide when a direction is drained.
   */
  queryDirection(
    direction: 'sent' | 'inbound',
    opts: { limit: number; afterSk?: string },
  ): Promise<readonly StoredEmailRow[]>;
  /** Fetch exactly one row by its full primary key, or `null` if absent. */
  getByKey(key: { pk: string; sk: string }): Promise<StoredEmailRow | null>;
}
