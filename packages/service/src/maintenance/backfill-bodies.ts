/**
 * One-off backfill: store a body on every row written before bodies were stored (#67), so the
 * reader's raw-MIME re-parse fallback can be removed.
 *
 * For each sent and inbound row without `body`:
 * - **sent, with its archive** (`sent/<id>`, #29): re-parse it as our own mail (`assumeExposed`)
 *   and store the body;
 * - **sent, without one** (pre-#29): nothing to recover; reported and left as is — the reader
 *   shows no body for it today either;
 * - **inbound whose stored verdicts don't expose content** (virus not `PASS`, or not parsed): it
 *   never has a body; skipped, as the reader skips it;
 * - **inbound otherwise**: re-parse its raw MIME (`inbound/<id>`; a legacy copy was never tagged,
 *   so it never expired) and store the body. A missing object is reported.
 *
 * The body is parsed with the reader's limits and stored the way ingest and send store one
 * (`storeEmailBody`: inline when small, else `bodies/<direction>/<id>.json`), so what is stored is
 * exactly what the reader shows today. The row write is conditional on `body` still being absent.
 *
 * The same scan reports the other legacy data the cleanup depends on: sent rows with attachments
 * but no recorded descriptors (`backfill-sent-attachments` fills those), and rows whose
 * attachment descriptors point at the old linked-upload prefix `attachments/outbound/`.
 *
 * Dry-run by default; pass `--apply` to write. Safe to re-run. Against a deployed stack:
 *
 *   AWS_PROFILE=… AWS_REGION=… EMAILS_TABLE=… MAIL_BUCKET=… \
 *     node packages/service/dist/maintenance/backfill-bodies.js [--apply]
 */
import type { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../data/document-client.js';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import type { EmailsDao, GetEmailOutput, StoredEmailBody } from '../data/emails-dao.js';
import { EmailEntity, isConditionalCheckFailed } from '../data/entities.js';
import { S3InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import { type MailBodyStore, S3MailBodyStore } from '../facades/s3-mail-body-store.js';
import { bodyKey, estimateRowBytes, storeEmailBody } from '../services/email-body-storage.js';
import { MAX_READ_BODY_BYTES } from '@freemail/shared';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HTML_BODY_BYTES,
  MAX_MIME_PARTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_TEXT_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
} from '../utils/inbound-limits.js';
import { type AttachmentSink, type ParsedInbound, type ParseLimits, type ParseOptions, parseInbound } from '../utils/inbound-parse.js';
import { decideExposure } from '../utils/verdicts.js';

/** Where a raw message is read from — the mail bucket. */
export interface RawMessageSource {
  getStream(key: string): Promise<Readable>;
}

/** Sets a row's body — only if the row exists and has none yet. */
export interface BodyWriter {
  setBody(row: GetEmailOutput, body: StoredEmailBody): Promise<'set' | 'already_set'>;
}

export type ParseRaw = (source: Readable, sink: AttachmentSink, limits?: ParseLimits, options?: ParseOptions) => Promise<ParsedInbound>;

export interface BackfillBodiesDeps {
  readonly emailsDao: EmailsDao;
  readonly writer: BodyWriter;
  readonly rawMessages: RawMessageSource;
  readonly bodies: MailBodyStore;
  /** When false, nothing is written — the report shows what WOULD be backfilled. */
  readonly apply: boolean;
  readonly parse?: ParseRaw;
  readonly log?: (line: string) => void;
}

export type BodyOutcome = 'backfilled' | 'would_backfill' | 'has_body' | 'not_exposable' | 'no_archive' | 'raw_missing';

export interface BackfillBodiesReport {
  readonly scanned: number;
  readonly outcomes: Record<BodyOutcome, number>;
  /** Sent rows with attachments but no recorded descriptors (run `backfill-sent-attachments`). */
  readonly sentAttachmentsUnrecorded: readonly string[];
  /** Rows with an attachment descriptor under `attachments/outbound/` (the old linked uploads). */
  readonly legacyLinkedAttachments: readonly string[];
}

/** The reader's parse limits for a legacy body: the full read cap, not a snippet-sized slice. */
const READ_PARSE_LIMITS: ParseLimits = {
  maxRawBytes: MAX_RAW_MESSAGE_BYTES,
  maxChildNodes: MAX_MIME_PARTS,
  maxHeadSize: MAX_HEADER_BLOCK_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxAttachmentTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
  maxTextBodyBytes: MAX_TEXT_BODY_BYTES,
  maxHtmlBodyBytes: MAX_HTML_BODY_BYTES,
  maxTotalBodyBytes: MAX_TOTAL_BODY_BYTES,
  maxRetainedBodyChars: MAX_READ_BODY_BYTES,
};

/** Only the body is wanted: attachments are never re-stored. */
const NOOP_SINK: AttachmentSink = {
  store: (partIndex, filename, contentType, bytes) => Promise.resolve({ id: String(partIndex), filename: filename ?? '', contentType, sizeBytes: bytes.length, s3Key: '' }),
};

/** A body store that writes nothing, for a dry run. */
const DRY_RUN_BODIES: MailBodyStore = {
  putBody: () => Promise.resolve(),
  getBody: () => Promise.resolve(null),
};

const NO_SUCH_KEY = 'NoSuchKey';
const PAGE_SIZE = 100;
const LEGACY_LINKED_PREFIX = 'attachments/outbound/';

export async function backfillBodies(deps: BackfillBodiesDeps): Promise<BackfillBodiesReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const outcomes: Record<BodyOutcome, number> = {
    backfilled: 0,
    would_backfill: 0,
    has_body: 0,
    not_exposable: 0,
    no_archive: 0,
    raw_missing: 0,
  };
  const sentAttachmentsUnrecorded: string[] = [];
  const legacyLinkedAttachments: string[] = [];
  let scanned = 0;
  for (const direction of ['sent', 'inbound'] as const) {
    let afterSk: string | undefined;
    for (;;) {
      const page = await deps.emailsDao.queryEmailsByDirection({ direction, limit: PAGE_SIZE, afterSk });
      for (const row of page.emails) {
        scanned += 1;
        outcomes[await backfillRow(row, deps, log)] += 1;
        if (row.direction === 'sent' && row.attachmentCount > 0 && row.attachments === undefined) {
          sentAttachmentsUnrecorded.push(row.id);
        }
        if ((row.attachments ?? []).some((attachment) => attachment.s3Key.startsWith(LEGACY_LINKED_PREFIX))) {
          legacyLinkedAttachments.push(row.id);
        }
      }
      if (page.emails.length < PAGE_SIZE) {
        break;
      }
      afterSk = page.emails[page.emails.length - 1].sk;
    }
  }
  return { scanned, outcomes, sentAttachmentsUnrecorded, legacyLinkedAttachments };
}

async function backfillRow(row: GetEmailOutput, deps: BackfillBodiesDeps, log: (line: string) => void): Promise<BodyOutcome> {
  if (row.body !== undefined) {
    return 'has_body';
  }
  let rawKey: string;
  let options: ParseOptions;
  if (row.direction === 'sent') {
    if (!row.rawS3Key) {
      log(`sent ${row.id}: no archived MIME — nothing to recover`);
      return 'no_archive';
    }
    rawKey = row.rawS3Key;
    options = { assumeExposed: true };
  } else {
    if (!decideExposure({ spamVerdict: row.spamVerdict, virusVerdict: row.virusVerdict }, row.parseStatus).exposeContent) {
      return 'not_exposable';
    }
    rawKey = row.rawS3Key;
    options = {};
  }

  let stream: Readable;
  try {
    stream = await deps.rawMessages.getStream(rawKey);
  } catch (err) {
    if (err instanceof Error && err.name === NO_SUCH_KEY) {
      log(`${row.direction} ${row.id}: raw message ${rawKey} is gone`);
      return 'raw_missing';
    }
    throw err;
  }
  const parsed = await (deps.parse ?? parseInbound)(stream, NOOP_SINK, READ_PARSE_LIMITS, options);
  if (!parsed.exposed) {
    log(`${row.direction} ${row.id}: re-parse exposes no content (parse ${parsed.parseStatus}) — skipped`);
    return 'not_exposable';
  }
  const body = await storeEmailBody(deps.apply ? deps.bodies : DRY_RUN_BODIES, {
    key: bodyKey(row.direction, row.id),
    text: parsed.textBody,
    html: parsed.htmlBody,
    otherRowBytes: estimateRowBytes(row),
  });
  const where = body.kind === 'inline' ? 'inline' : body.s3Key;
  if (!deps.apply) {
    log(`${row.direction} ${row.id}: would store its body (${where})`);
    return 'would_backfill';
  }
  if ((await deps.writer.setBody(row, body)) === 'already_set') {
    return 'has_body';
  }
  log(`${row.direction} ${row.id}: stored its body (${where})`);
  return 'backfilled';
}

/** DynamoDB {@link BodyWriter}: a conditional SET that never overwrites a body. */
export class DdbBodyWriter implements BodyWriter {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async setBody(row: GetEmailOutput, body: StoredEmailBody): Promise<'set' | 'already_set'> {
    const key = row.direction === 'sent' ? EmailEntity.sent(row.sentAt, row.id) : EmailEntity.inbound(row.receivedAt, row.id, false);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: 'SET #body = :body',
          ExpressionAttributeNames: { '#body': 'body' },
          ExpressionAttributeValues: { ':body': body },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#body)',
        }),
      );
      return 'set';
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        return 'already_set';
      }
      throw err;
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const tableName = process.env.EMAILS_TABLE;
  const bucket = process.env.MAIL_BUCKET;
  if (!tableName || !bucket) {
    throw new Error('Set EMAILS_TABLE and MAIL_BUCKET (the deployed stack resources).');
  }
  const apply = argv.includes('--apply');
  const doc = createDocumentClient();
  const s3 = new S3Client({});
  const report = await backfillBodies({
    emailsDao: new DdbEmailsDao(doc, tableName),
    writer: new DdbBodyWriter(doc, tableName),
    rawMessages: new S3InboundObjectStore(s3, bucket),
    bodies: new S3MailBodyStore(s3, bucket),
    apply,
  });
  console.log(JSON.stringify({ apply, ...report }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
