/**
 * DynamoDB-backed {@link EmailsRepo} over #2's `emailsTable` (composite key
 * `pk`/`sk`). Sent messages share one partition so they list newest-first:
 *   { pk: 'SENT', sk: '<sentAtIso>#<id>', direction: 'sent', ...metadata }
 *
 * Phase 2's read slice adds an `INBOUND` partition to the same table and the
 * list/get queries. The put is conditional (`attribute_not_exists(pk)`) so a
 * re-used id can never clobber an existing row.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { EmailsRepo, SentEmailRecord } from './emails-repo.js';

/** Partition holding sent messages (inbound gets its own partition in Phase 2). */
const SENT_PARTITION = 'SENT';

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
}
