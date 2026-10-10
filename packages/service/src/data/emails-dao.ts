/**
 * Persistence port for email metadata. Kept an interface so the {@link EmailService}
 * (sent side), the inbound processor, and the read service are all testable with a fake
 * without knowing about DynamoDB.
 *
 * Both directions share one table: sent messages under `pk='SENT'`, received under
 * `pk='INBOUND'` — or `pk='FAILED'` when their content could not be extracted (the Errors
 * folder) — each `sk='<iso>#<id>'` so the read slice lists any partition newest-first and
 * merges sent + received into one timeline.
 */
import type { EmailListFilter, SentStatus } from '@freemail/shared';
import type { EmailListIndexAttribute } from '@freemail/shared/storage';

/** Partition holding sent messages. */
export const SENT_PARTITION = 'SENT';
/** Partition holding received messages. */
export const INBOUND_PARTITION = 'INBOUND';
/**
 * Partition holding received messages whose content could not be extracted — a virus verdict
 * other than `PASS`, or a parse failure / limit breach. Their raw MIME is kept in the
 * quarantine bucket. Listed as the Errors folder, never in the main timeline.
 */
export const FAILED_PARTITION = 'FAILED';

/** The only valid partitions — used to validate a decoded message handle. */
export const EMAIL_PARTITIONS: ReadonlySet<string> = new Set([
  SENT_PARTITION,
  INBOUND_PARTITION,
  FAILED_PARTITION,
]);

/**
 * A message's decoded body, stored once when the message is ingested or sent so opening it
 * never re-parses raw MIME. Small bodies live inline in the row; larger ones in S3. Never
 * projected into the list index — only `getEmail` reads it.
 */
export type StoredEmailBody =
  | {
      readonly kind: 'inline';
      readonly text?: string;
      readonly html?: string;
      /** True when a part was cut to the per-part cap at storage time. */
      readonly truncated?: boolean;
    }
  | {
      readonly kind: 's3';
      /** Server-side pointer to the `{ text?, html?, truncated? }` JSON object (`bodies/...`). */
      readonly s3Key: string;
    };

/** Metadata for one sent message — headers + SES id + status + its stored body. */
export interface CreateSentEmailInput {
  /** FreeMail's own id for the message. */
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  /**
   * The message id SES assigned. Absent until SES accepts the message: the row is first
   * written `status:'sending'` with no id, then the id is set on the `'sent'` transition.
   */
  readonly sesMessageId?: string;
  /** Send time (attempt time), ISO-8601 — the sort-key basis, stable across the status update. */
  readonly sentAt: string;
  readonly attachmentCount: number;
  /** Size of the raw MIME message in bytes. */
  readonly sizeBytes: number;
  /**
   * Delivery status, set write-before-send (`sending` → `sent`/`send_failed`). Optional on the
   * type so a legacy row written before this field reads back without it (→ envelope-only detail).
   */
  readonly status?: SentStatus;
  /**
   * S3 pointer to the archived composed raw MIME (`sent/<id>`) — permanent; backs the `.eml`
   * download (and the body of a legacy row stored before `body`). Absent on a pre-#29 row.
   */
  readonly rawS3Key?: string;
  /** Short failure reason on a `send_failed` row — server-side only, never surfaced in the read DTO. */
  readonly error?: string;
  /**
   * One descriptor per attachment the message carried, in request order, each pointing at its
   * permanent copy `attachments/sent/<id>/<index>` (embedded or linked alike; rows from before
   * direct uploads point linked ones at `attachments/outbound/*`). Absent on a row written
   * before attachments were recorded (the read path treats that as none).
   */
  readonly attachments?: readonly SentAttachmentDescriptor[];
  /** The body as sent (download links included). Absent on a row written before bodies were stored. */
  readonly body?: StoredEmailBody;
}

/** Nothing to report: the conditional put either landed or threw. */
export interface CreateSentEmailOutput {}

/**
 * A stored attachment of a sent message. Same shape as the inbound descriptor so the read path
 * presigns either direction the same way; `s3Key` is server-side only.
 */
export type SentAttachmentDescriptor = InboundAttachmentDescriptor;

/**
 * The terminal status transition of a sent message after the SES call: `sent` (+ `sesMessageId`)
 * or `send_failed` (+ `error`). Keyed by `id` + `sentAt` (the sort-key basis), so the update
 * targets the exact row without moving it.
 */
export interface UpdateSentEmailStatusInput {
  readonly id: string;
  readonly sentAt: string;
  readonly status: Extract<SentStatus, 'sent' | 'send_failed'>;
  /** Set on `sent`. */
  readonly sesMessageId?: string;
  /** Set on `send_failed` — a short reason. */
  readonly error?: string;
}

/** Nothing to report: the conditional update either landed or threw. */
export interface UpdateSentEmailStatusOutput {}

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
  /**
   * Stable per-message id: the MIME part index, or `link-<n>` for a file one of your own links
   * named.
   */
  readonly id: string;
  /** Original, sanitized filename — metadata only, never used in the S3 key. */
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /**
   * Server-side S3 pointer — `attachments/inbound/<id>/<partIndex>`, or a linked file's sent copy
   * `attachments/sent/<id>/<n>`. Never exposed by the read API.
   */
  readonly s3Key: string;
}

/** Metadata for one received message. Attachments + snippet are present only when content is exposable. */
export interface CreateInboundEmailInput {
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
  /**
   * S3 pointer to SES's raw MIME (`inbound/<id>`). Staging only: it expires after
   * `INBOUND_RAW_RETENTION_DAYS`, so it backs the `.eml` download only while it exists.
   */
  readonly rawS3Key: string;
  /** Raw MIME size in bytes (from S3 `HeadObject`). */
  readonly sizeBytes: number;
  /**
   * True when content could not be extracted (virus verdict not `PASS`, or parse status not
   * `ok`): the row is stored under {@link FAILED_PARTITION} and its raw MIME is copied to the
   * quarantine bucket at {@link quarantineS3Key}.
   */
  readonly failed?: boolean;
  /** Key of the raw MIME's copy in the quarantine bucket — set exactly when `failed`. */
  readonly quarantineS3Key?: string;
  /**
   * The decoded body — present ONLY when content is exposable (parsed + virus `PASS`), like
   * the snippet. Absent on a row written before bodies were stored.
   */
  readonly body?: StoredEmailBody;
}

export interface CreateInboundEmailOutput {
  /**
   * False when the row already existed. Inbound delivery is at-least-once, so a redelivery
   * must be a no-op rather than a double-write — this is that signal.
   */
  readonly created: boolean;
}

/**
 * A stored row plus its DynamoDB sort key — the input fields plus what the server derives.
 * The read slice (#11) needs `sk` to mint the opaque message handle and the pagination
 * cursor: both derive from `{ pk, sk }`, never from a client-supplied key.
 */
export type GetEmailOutput =
  | ({
      readonly direction: 'sent';
      readonly pk: string;
      readonly sk: string;
    } & CreateSentEmailInput)
  | ({
      readonly direction: 'inbound';
      readonly pk: string;
      readonly sk: string;
    } & CreateInboundEmailInput);

export interface GetEmailInput {
  readonly pk: string;
  readonly sk: string;
}

export interface QueryEmailsByDirectionInput {
  /** Which partition: a direction, or `failed` (received mail in the Errors folder). */
  readonly direction: EmailListFilter;
  readonly limit: number;
  /** Return only rows strictly older than this sort key; omit to start from the newest. */
  readonly afterSk?: string | undefined;
}

export interface QueryEmailsByDirectionOutput {
  /** Newest-first, at most the requested `limit`. */
  readonly emails: ReadonlyArray<GetEmailOutput>;
}

/**
 * One row as the list index carries it: its keys plus only the projected list fields. Derived
 * from the projection list itself, so a field the index does not carry is not on this type —
 * reading one (in the list mapper, say) is a compile error rather than a silent `undefined`.
 */
export type EmailSummary =
  | ({ readonly direction: 'sent'; readonly pk: string; readonly sk: string } & Pick<
      CreateSentEmailInput,
      EmailListIndexAttribute & keyof CreateSentEmailInput
    >)
  | ({ readonly direction: 'inbound'; readonly pk: string; readonly sk: string } & Pick<
      CreateInboundEmailInput,
      EmailListIndexAttribute & keyof CreateInboundEmailInput
    >);

/** Same paging contract as {@link QueryEmailsByDirectionInput}, answered from the list index. */
export interface ListEmailSummariesInput extends QueryEmailsByDirectionInput {}

export interface ListEmailSummariesOutput {
  /** Newest-first, at most the requested `limit`. */
  readonly emails: ReadonlyArray<EmailSummary>;
}

export interface EmailsDao {
  /**
   * Record a sent message before the SES call (`status:'sending'`, with `rawS3Key` +
   * metadata, no `sesMessageId` yet). Conditional on the id not already existing, so a
   * reused id can never clobber an existing row.
   */
  createSentEmail(input: CreateSentEmailInput): Promise<CreateSentEmailOutput>;

  /**
   * Apply the terminal status transition after the SES call — `sent` (+ `sesMessageId`) or
   * `send_failed` (+ `error`). Conditional on the row existing (it was just written); a
   * plain `SET`, it never moves the row (the sort key derives from the unchanged `sentAt`).
   */
  updateSentEmailStatus(input: UpdateSentEmailStatusInput): Promise<UpdateSentEmailStatusOutput>;

  /** Record a received message, idempotently. */
  createInboundEmail(input: CreateInboundEmailInput): Promise<CreateInboundEmailOutput>;

  /**
   * One partition (`'sent'` → `pk='SENT'`, `'inbound'` → `pk='INBOUND'`), newest-first, at
   * most `limit` rows strictly older than `afterSk` (omit `afterSk` to start from the
   * newest). Fewer than `limit` rows means the partition is exhausted past that point — the
   * read service uses that to decide when a direction is drained.
   */
  queryEmailsByDirection(input: QueryEmailsByDirectionInput): Promise<QueryEmailsByDirectionOutput>;

  /**
   * The mailbox list page for one partition: the same paging contract as
   * {@link queryEmailsByDirection}, but read from the list index, so each row carries only the
   * list fields ({@link EmailSummary}) and the read is sized by those, not by the full items.
   */
  listEmailSummaries(input: ListEmailSummariesInput): Promise<ListEmailSummariesOutput>;

  /** Fetch exactly one row by its full primary key, or `null` if absent. */
  getEmail(input: GetEmailInput): Promise<GetEmailOutput | null>;
}
