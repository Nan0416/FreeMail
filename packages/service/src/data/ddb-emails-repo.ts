/**
 * DynamoDB-backed {@link EmailsRepo} over #2's `emailsTable` (composite key
 * `pk`/`sk`). Each direction shares one partition so it lists newest-first:
 *   { pk: 'SENT',    sk: '<sentAtIso>#<id>',     direction: 'sent',    ...metadata }
 *   { pk: 'INBOUND', sk: '<receivedAtIso>#<id>', direction: 'inbound', ...metadata }
 *
 * The read slice (#11) adds the list/get queries over both partitions. Every put is
 * conditional (`attribute_not_exists(pk)`) so a re-used id can never clobber an
 * existing row — and for inbound, so an at-least-once S3 redelivery is a no-op.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  type GetCommandOutput,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  type EmailsReadRepo,
  type EmailsRepo,
  type InboundEmailRecord,
  INBOUND_PARTITION,
  type SentEmailRecord,
  SENT_PARTITION,
  type SentStatusUpdate,
  type StoredEmailRow,
} from './emails-repo.js';

/** DynamoDB's error name for a failed `ConditionExpression` — here, the row already existed. */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** The slice of the document client this repo uses — injectable so the logic is testable against a fake. */
export interface EmailsDocClient {
  send(command: PutCommand | QueryCommand | GetCommand | UpdateCommand): Promise<unknown>;
}

/** Direction → partition. */
const PARTITION: Record<'sent' | 'inbound', string> = {
  sent: SENT_PARTITION,
  inbound: INBOUND_PARTITION,
};

/** Reconstruct the typed union row from a stored item (we wrote the shape, so trust `direction`). */
function toRow(item: Record<string, unknown>): StoredEmailRow {
  const sk = String(item.sk);
  if (item.direction === 'inbound') {
    return { ...(item as unknown as InboundEmailRecord), direction: 'inbound', sk };
  }
  return { ...(item as unknown as SentEmailRecord), direction: 'sent', sk };
}

export class DdbEmailsRepo implements EmailsRepo, EmailsReadRepo {
  private readonly doc: EmailsDocClient;

  constructor(
    private readonly tableName: string,
    doc?: EmailsDocClient,
  ) {
    this.doc =
      doc ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }) as unknown as EmailsDocClient);
  }

  async putSent(record: SentEmailRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: SENT_PARTITION,
          sk: `${record.sentAt}#${record.id}`,
          direction: 'sent',
          id: record.id,
          from: record.from,
          to: record.to,
          cc: record.cc,
          bcc: record.bcc,
          subject: record.subject,
          // Undefined at the initial 'sending' write; removeUndefinedValues drops it, and it's
          // filled by updateSentStatus on the 'sent' transition.
          sesMessageId: record.sesMessageId,
          sentAt: record.sentAt,
          attachmentCount: record.attachmentCount,
          sizeBytes: record.sizeBytes,
          status: record.status,
          rawS3Key: record.rawS3Key,
          error: record.error,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  }

  async updateSentStatus(update: SentStatusUpdate): Promise<void> {
    // 'status' is a DynamoDB reserved word; alias every updated name to be safe.
    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':status': update.status };
    const sets = ['#status = :status'];
    if (update.sesMessageId !== undefined) {
      names['#mid'] = 'sesMessageId';
      values[':mid'] = update.sesMessageId;
      sets.push('#mid = :mid');
    }
    if (update.error !== undefined) {
      names['#error'] = 'error';
      values[':error'] = update.error;
      sets.push('#error = :error');
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: SENT_PARTITION, sk: `${update.sentAt}#${update.id}` },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        // The row was just written by putSent; guard against a vanished/absent row.
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  async putInbound(record: InboundEmailRecord): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: INBOUND_PARTITION,
            sk: `${record.receivedAt}#${record.id}`,
            direction: 'inbound',
            id: record.id,
            sesMessageId: record.sesMessageId,
            from: record.from,
            fromName: record.fromName,
            to: record.to,
            cc: record.cc,
            subject: record.subject,
            snippet: record.snippet,
            receivedAt: record.receivedAt,
            headerDate: record.headerDate,
            hasAttachments: record.hasAttachments,
            attachmentCount: record.attachmentCount,
            attachments: record.attachments,
            spamVerdict: record.spamVerdict,
            virusVerdict: record.virusVerdict,
            parseStatus: record.parseStatus,
            quarantined: record.quarantined,
            rawS3Key: record.rawS3Key,
            sizeBytes: record.sizeBytes,
          },
          // The idempotency guard: a redelivered event finds the row present and no-ops.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === CONDITIONAL_CHECK_FAILED) {
        return false;
      }
      throw err;
    }
  }

  async queryDirection(
    direction: 'sent' | 'inbound',
    opts: { limit: number; afterSk?: string },
  ): Promise<StoredEmailRow[]> {
    const pk = PARTITION[direction];
    const out = (await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        // Newest-first: sk = '<iso>#<id>' sorts lexicographically by receipt/send time.
        ScanIndexForward: false,
        Limit: opts.limit,
        // Resume strictly after the last row we emitted for this partition. pk is
        // server-derived (never client-supplied), so a crafted cursor can't retarget it.
        ...(opts.afterSk ? { ExclusiveStartKey: { pk, sk: opts.afterSk } } : {}),
      }),
    )) as QueryCommandOutput;
    return (out.Items ?? []).map(toRow);
  }

  async getByKey(key: { pk: string; sk: string }): Promise<StoredEmailRow | null> {
    const out = (await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: key.pk, sk: key.sk } }),
    )) as GetCommandOutput;
    return out.Item ? toRow(out.Item) : null;
  }
}
