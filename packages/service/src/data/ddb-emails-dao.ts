/**
 * DynamoDB-backed {@link EmailsDao} over #2's `emailsTable` (composite key
 * `pk`/`sk`). Each direction shares one partition so it lists newest-first:
 *   { pk: 'SENT',    sk: '<sentAtIso>#<id>',     direction: 'sent',    ...metadata }
 *   { pk: 'INBOUND', sk: '<receivedAtIso>#<id>', direction: 'inbound', ...metadata }
 *
 * The read slice (#11) adds the list/get queries over both partitions; the mailbox list reads
 * the `list` GSI (same keys, list fields only) so a page is sized by those fields, not by the
 * full items. Every put is conditional (`attribute_not_exists(pk)`) so a re-used id can never
 * clobber an existing row — and for inbound, so an at-least-once S3 redelivery is a no-op.
 */
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { EmailListFilter } from '@freemail/shared';
import { EMAIL_LIST_INDEX_NAME } from '@freemail/shared/storage';
import { getLogger } from '../utils/logger.js';
import { CONDITIONAL_CHECK_FAILED, EmailEntity } from './entities.js';
import type {
  CreateInboundEmailInput,
  CreateInboundEmailOutput,
  CreateSentEmailInput,
  CreateSentEmailOutput,
  EmailSummary,
  EmailsDao,
  GetEmailInput,
  GetEmailOutput,
  ListEmailSummariesInput,
  ListEmailSummariesOutput,
  QueryEmailsByDirectionInput,
  QueryEmailsByDirectionOutput,
  UpdateSentEmailStatusInput,
  UpdateSentEmailStatusOutput,
} from './emails-dao.js';

/** Reconstruct the typed union row from a stored item (we wrote the shape, so trust `direction`). */
function toRow(item: Record<string, unknown>): GetEmailOutput {
  const pk = String(item.pk);
  const sk = String(item.sk);
  if (item.direction === 'inbound') {
    return { ...(item as unknown as CreateInboundEmailInput), direction: 'inbound', pk, sk };
  }
  return { ...(item as unknown as CreateSentEmailInput), direction: 'sent', pk, sk };
}

const logger = getLogger('DdbEmailsDao');

/** How long to trust a "list index not readable yet" answer before asking DynamoDB again. */
const INDEX_RECHECK_MS = 30_000;

type SentSummaryFields = Omit<
  Extract<EmailSummary, { readonly direction: 'sent' }>,
  'direction' | 'pk' | 'sk'
>;
type InboundSummaryFields = Omit<
  Extract<EmailSummary, { readonly direction: 'inbound' }>,
  'direction' | 'pk' | 'sk'
>;

/**
 * The same reconstruction for a list-index entry, which carries only the projected fields.
 * The direction comes from the partition that was queried, never from a projected attribute,
 * so the list's merge and cursor can't be misled by a projection change.
 */
function toSummary(item: Record<string, unknown>, filter: EmailListFilter): EmailSummary {
  const pk = String(item.pk);
  const sk = String(item.sk);
  // The Errors folder holds received mail: a `failed` row is still an inbound message.
  if (filter !== 'sent') {
    return { ...(item as unknown as InboundSummaryFields), direction: 'inbound', pk, sk };
  }
  return { ...(item as unknown as SentSummaryFields), direction: 'sent', pk, sk };
}

/** DynamoDB's answer to a query on an index the table does not have (removed, or never created). */
function isIndexNotReadable(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'ValidationException' &&
    /does not have the specified index/i.test(err.message)
  );
}

export class DdbEmailsDao implements EmailsDao {
  private readonly doc: DynamoDBDocumentClient;
  /** A list index confirmed readable stays trusted until a query reports it missing. */
  private listIndexReadable = false;
  private listIndexCheckedAtMs: number | undefined;
  /** The DescribeTable call in flight, shared so concurrent first calls ask only once. */
  private listIndexCheck: Promise<boolean> | undefined;

  constructor(
    doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = doc;
  }

  async createSentEmail(input: CreateSentEmailInput): Promise<CreateSentEmailOutput> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: EmailEntity.SENT_PARTITION,
          sk: `${input.sentAt}#${input.id}`,
          direction: 'sent',
          id: input.id,
          from: input.from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          // Undefined at the initial 'sending' write; removeUndefinedValues drops it, and it's
          // filled by updateSentStatus on the 'sent' transition.
          sesMessageId: input.sesMessageId,
          sentAt: input.sentAt,
          attachmentCount: input.attachmentCount,
          sizeBytes: input.sizeBytes,
          status: input.status,
          rawS3Key: input.rawS3Key,
          error: input.error,
          attachments: input.attachments,
          body: input.body,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return {};
  }

  async updateSentEmailStatus(
    input: UpdateSentEmailStatusInput,
  ): Promise<UpdateSentEmailStatusOutput> {
    // 'status' is a DynamoDB reserved word; alias every updated name to be safe.
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':status': input.status };
    const sets = ['#status = :status'];
    if (input.sesMessageId !== undefined) {
      names['#mid'] = 'sesMessageId';
      values[':mid'] = input.sesMessageId;
      sets.push('#mid = :mid');
    }
    if (input.error !== undefined) {
      names['#error'] = 'error';
      values[':error'] = input.error;
      sets.push('#error = :error');
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: EmailEntity.SENT_PARTITION, sk: `${input.sentAt}#${input.id}` },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        // The row was just written by putSent; guard against a vanished/absent row.
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    return {};
  }

  async createInboundEmail(input: CreateInboundEmailInput): Promise<CreateInboundEmailOutput> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...EmailEntity.inbound(input.receivedAt, input.id, input.failed === true),
            direction: 'inbound',
            id: input.id,
            sesMessageId: input.sesMessageId,
            from: input.from,
            fromName: input.fromName,
            to: input.to,
            cc: input.cc,
            subject: input.subject,
            snippet: input.snippet,
            receivedAt: input.receivedAt,
            headerDate: input.headerDate,
            hasAttachments: input.hasAttachments,
            attachmentCount: input.attachmentCount,
            attachments: input.attachments,
            spamVerdict: input.spamVerdict,
            virusVerdict: input.virusVerdict,
            parseStatus: input.parseStatus,
            quarantined: input.quarantined,
            rawS3Key: input.rawS3Key,
            sizeBytes: input.sizeBytes,
            failed: input.failed,
            quarantineS3Key: input.quarantineS3Key,
            body: input.body,
          },
          // The idempotency guard: a redelivered event finds the row present and no-ops.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { created: true };
    } catch (err) {
      if (err instanceof Error && err.name === CONDITIONAL_CHECK_FAILED) {
        return { created: false };
      }
      throw err;
    }
  }

  async queryEmailsByDirection(
    input: QueryEmailsByDirectionInput,
  ): Promise<QueryEmailsByDirectionOutput> {
    return { emails: (await this.queryPartition(input)).map(toRow) };
  }

  async listEmailSummaries(input: ListEmailSummariesInput): Promise<ListEmailSummariesOutput> {
    // Until the index is readable, serve the page from the table: same keys, same order, same
    // paging — just larger reads. So the list is never incomplete while a new index builds.
    let items: Record<string, unknown>[];
    if (!(await this.isListIndexReadable())) {
      items = await this.queryPartition(input);
    } else {
      try {
        items = await this.queryPartition(input, EMAIL_LIST_INDEX_NAME);
      } catch (err) {
        if (!isIndexNotReadable(err)) {
          throw err;
        }
        logger.warn(
          `List index "${EMAIL_LIST_INDEX_NAME}" is missing; listing from the table.`,
          err,
        );
        this.listIndexReadable = false;
        items = await this.queryPartition(input);
      }
    }
    return { emails: items.map((item) => toSummary(item, input.direction)) };
  }

  /**
   * True once the list index is fully built (ACTIVE, or UPDATING a setting on a built index)
   * and not backfilling. A backfilling GSI is NOT rejected by DynamoDB — it answers queries with
   * whatever it has indexed so far, silently partial — and CloudFormation does not wait for a
   * newly added GSI to backfill before it updates the Lambdas that read it. So readiness is asked
   * of DescribeTable (covered by the table's read grant), cached once confirmed, and re-asked at
   * most every {@link INDEX_RECHECK_MS} until then; concurrent first calls share one request.
   */
  private async isListIndexReadable(): Promise<boolean> {
    if (this.listIndexReadable) {
      return true;
    }
    if (this.listIndexCheck !== undefined) {
      return this.listIndexCheck;
    }
    const nowMs = Date.now();
    if (
      this.listIndexCheckedAtMs !== undefined &&
      nowMs - this.listIndexCheckedAtMs < INDEX_RECHECK_MS
    ) {
      return false;
    }
    this.listIndexCheckedAtMs = nowMs;
    this.listIndexCheck = this.describeListIndex().finally(() => {
      this.listIndexCheck = undefined;
    });
    return this.listIndexCheck;
  }

  /** Ask DescribeTable about the list index. Logged when not readable, so a lasting fallback shows. */
  private async describeListIndex(): Promise<boolean> {
    try {
      const out = await this.doc.send(new DescribeTableCommand({ TableName: this.tableName }));
      const index = out.Table?.GlobalSecondaryIndexes?.find(
        (candidate) => candidate.IndexName === EMAIL_LIST_INDEX_NAME,
      );
      const built = index?.IndexStatus === 'ACTIVE' || index?.IndexStatus === 'UPDATING';
      this.listIndexReadable = built && index?.Backfilling !== true;
    } catch (err) {
      logger.warn('Could not describe the emails table; listing from the table for now.', err);
      return false;
    }
    if (!this.listIndexReadable) {
      logger.warn(
        `List index "${EMAIL_LIST_INDEX_NAME}" is not built yet; listing from the table.`,
      );
    }
    return this.listIndexReadable;
  }

  /**
   * Up to `limit` items of one partition, newest-first, strictly older than `afterSk` — from
   * the table, or from an index that shares its keys.
   *
   * DynamoDB ends a Query page after 1 MB of data read even when fewer than `Limit` items
   * matched, handing back a `LastEvaluatedKey`. So keep reading until the page is full or the
   * partition really ends: callers treat "fewer than `limit`" as exhausted (the list merge
   * decides a direction is drained on it), and a 1 MB cut would otherwise silently end the
   * timeline early.
   */
  private async queryPartition(
    input: QueryEmailsByDirectionInput,
    indexName?: string,
  ): Promise<Record<string, unknown>[]> {
    const pk = EmailEntity.partitionFor(input.direction);
    const items: Record<string, unknown>[] = [];
    // Resume strictly after the last row we emitted for this partition. pk is server-derived
    // (never client-supplied), so a crafted cursor can't retarget it. The index shares the
    // table's keys, so the same {pk, sk} is a valid start key for either.
    let startKey: Record<string, unknown> | undefined = input.afterSk
      ? { pk, sk: input.afterSk }
      : undefined;
    do {
      const out = (await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          ...(indexName ? { IndexName: indexName } : {}),
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          // Newest-first: sk = '<iso>#<id>' sorts lexicographically by receipt/send time.
          ScanIndexForward: false,
          Limit: input.limit - items.length,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      )) as QueryCommandOutput;
      items.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
    } while (startKey !== undefined && items.length < input.limit);
    return items;
  }

  async getEmail(input: GetEmailInput): Promise<GetEmailOutput | null> {
    const out = (await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: input.pk, sk: input.sk } }),
    )) as GetCommandOutput;
    return out.Item ? toRow(out.Item) : null;
  }
}
