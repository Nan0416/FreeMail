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
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { EmailsRepo, InboundEmailRecord, SentEmailRecord } from './emails-repo.js';

/** Partition holding sent messages. */
const SENT_PARTITION = 'SENT';
/** Partition holding received messages. */
const INBOUND_PARTITION = 'INBOUND';

/** DynamoDB's error name for a failed `ConditionExpression` — here, the row already existed. */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** The slice of the document client this repo uses — injectable so the logic is testable against a fake. */
export interface EmailsDocClient {
  send(command: PutCommand): Promise<unknown>;
}

export class DdbEmailsRepo implements EmailsRepo {
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
          sesMessageId: record.sesMessageId,
          sentAt: record.sentAt,
          attachmentCount: record.attachmentCount,
          sizeBytes: record.sizeBytes,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
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
}
