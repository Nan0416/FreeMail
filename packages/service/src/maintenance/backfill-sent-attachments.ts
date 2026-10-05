/**
 * One-off backfill: give sent rows written before attachments were recorded their attachment
 * descriptors, so `GET /emails/{id}` lists them and the attachment route can presign them.
 *
 * New sends record descriptors themselves (see {@link EmailService}); only older rows need this.
 * For each such row with `attachmentCount > 0`, the archived MIME (`sent/<id>`, #29) is
 * re-parsed and every embedded attachment is copied to `attachments/sent/<id>/<n>` — the same
 * layout a new send writes — then the descriptors are set on the row.
 *
 * Safe to re-run: a row that already has `attachments` is skipped, and the write is conditional
 * on the field still being absent. A row whose archive yields a different number of attachments
 * than it recorded (e.g. one sent with a LINKED large attachment, which isn't in the MIME) is
 * reported and left untouched rather than half-filled.
 *
 * Dry-run by default; pass `--apply` to write. Run against a deployed stack with:
 *
 *   AWS_PROFILE=… AWS_REGION=… EMAILS_TABLE=… MAIL_BUCKET=… \
 *     node packages/service/dist/maintenance/backfill-sent-attachments.js [--apply]
 */
import { S3Client } from '@aws-sdk/client-s3';
import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from '../data/document-client.js';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import type {
  EmailsReadDao,
  GetEmailOutput,
  SentAttachmentDescriptor,
} from '../data/emails-dao.js';
import { EmailEntity } from '../data/entities.js';
import { S3InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import {
  type OutboundObjectStore,
  S3OutboundObjectStore,
} from '../facades/s3-outbound-object-store.js';
import type { ParseInbound, RawMimeSource } from '../services/email-read-service.js';
import { sentAttachmentKey } from '../services/email-service.js';
import { parseInbound } from '../utils/inbound-parse.js';

/** Sets a sent row's descriptors — only if the row exists and has none yet. */
export interface SentAttachmentsWriter {
  setAttachments(
    row: { readonly id: string; readonly sentAt: string },
    attachments: readonly SentAttachmentDescriptor[],
  ): Promise<void>;
}

export interface BackfillDeps {
  readonly emailsDao: EmailsReadDao;
  readonly writer: SentAttachmentsWriter;
  readonly rawMime: RawMimeSource;
  readonly objectStore: OutboundObjectStore;
  /** When false, nothing is written — the report shows what WOULD be backfilled. */
  readonly apply: boolean;
  readonly parse?: ParseInbound;
  readonly log?: (line: string) => void;
}

export type BackfillOutcome =
  | 'backfilled'
  | 'would_backfill'
  | 'already_recorded'
  | 'no_attachments'
  | 'no_archive'
  | 'mismatch';

export interface BackfillReport {
  readonly scanned: number;
  readonly outcomes: Readonly<Record<BackfillOutcome, number>>;
}

const PAGE_SIZE = 100;

export async function backfillSentAttachments(deps: BackfillDeps): Promise<BackfillReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const outcomes: Record<BackfillOutcome, number> = {
    backfilled: 0,
    would_backfill: 0,
    already_recorded: 0,
    no_attachments: 0,
    no_archive: 0,
    mismatch: 0,
  };
  let scanned = 0;
  let afterSk: string | undefined;
  for (;;) {
    const page = await deps.emailsDao.queryEmailsByDirection({
      direction: 'sent',
      limit: PAGE_SIZE,
      afterSk,
    });
    for (const row of page) {
      scanned += 1;
      const outcome = await backfillRow(row, deps, log);
      outcomes[outcome] += 1;
    }
    if (page.length < PAGE_SIZE) {
      break;
    }
    afterSk = page[page.length - 1].sk;
  }
  return { scanned, outcomes };
}

async function backfillRow(
  row: GetEmailOutput,
  deps: BackfillDeps,
  log: (line: string) => void,
): Promise<BackfillOutcome> {
  if (row.direction !== 'sent') {
    return 'no_attachments';
  }
  if (row.attachments !== undefined) {
    return 'already_recorded';
  }
  if (row.attachmentCount === 0) {
    return 'no_attachments';
  }
  if (!row.rawS3Key) {
    log(`${row.id}: ${row.attachmentCount} attachment(s) but no archived MIME — skipped`);
    return 'no_archive';
  }

  const descriptors: SentAttachmentDescriptor[] = [];
  const parse = deps.parse ?? parseInbound;
  const parsed = await parse(
    await deps.rawMime.getStream(row.rawS3Key),
    {
      // Our own archived MIME carries only the attachments we embedded, in request order.
      store: async (_partIndex, filename, contentType, bytes) => {
        const index = descriptors.length;
        const descriptor: SentAttachmentDescriptor = {
          id: String(index),
          filename: filename ?? `attachment-${index + 1}`,
          contentType,
          sizeBytes: bytes.length,
          s3Key: sentAttachmentKey(row.id, index),
        };
        if (deps.apply) {
          await deps.objectStore.put(descriptor.s3Key, bytes);
        }
        descriptors.push(descriptor);
        return descriptor;
      },
    },
    undefined,
    { assumeExposed: true },
  );

  if (parsed.parseStatus !== 'ok' || descriptors.length !== row.attachmentCount) {
    log(
      `${row.id}: recorded ${row.attachmentCount} attachment(s), archive yielded ` +
        `${descriptors.length} (parse ${parsed.parseStatus}) — left untouched`,
    );
    return 'mismatch';
  }
  const summary = descriptors.map((d) => `${d.filename} (${d.sizeBytes} B)`).join(', ');
  if (!deps.apply) {
    log(`${row.id}: would record ${summary}`);
    return 'would_backfill';
  }
  await deps.writer.setAttachments(row, descriptors);
  log(`${row.id}: recorded ${summary}`);
  return 'backfilled';
}

/** DynamoDB {@link SentAttachmentsWriter}: a conditional SET that never overwrites descriptors. */
export class DdbSentAttachmentsWriter implements SentAttachmentsWriter {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async setAttachments(
    row: { readonly id: string; readonly sentAt: string },
    attachments: readonly SentAttachmentDescriptor[],
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: EmailEntity.sent(row.sentAt, row.id),
        UpdateExpression: 'SET #attachments = :attachments',
        ExpressionAttributeNames: { '#attachments': 'attachments' },
        ExpressionAttributeValues: { ':attachments': attachments },
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#attachments)',
      }),
    );
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
  const report = await backfillSentAttachments({
    emailsDao: new DdbEmailsDao(doc, tableName),
    writer: new DdbSentAttachmentsWriter(doc, tableName),
    rawMime: new S3InboundObjectStore(s3, bucket),
    objectStore: new S3OutboundObjectStore(s3, bucket),
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
