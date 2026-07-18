/**
 * DynamoDB-backed {@link DownloadTokensRepo} over #2's `downloadTokensTable`
 * (partition key `token`, TTL on `ttl`). One row per token:
 *   { token, s3Key, filename, contentType, sizeBytes, emailId,
 *     createdAt, expiresAt, ttl, revoked, downloadCount, maxDownloads? }
 *
 * `create` is a conditional put so a token collision never clobbers an existing row.
 * `claim` folds ALL the download gates (exists, not revoked, not expired, under the
 * optional cap) into ONE conditional `UpdateItem` that also increments the counter —
 * so the check-and-consume is atomic. Concurrent claims cannot bypass a `maxDownloads`
 * cap (the last claim to reach the cap wins; the next fails the condition), and a
 * failed condition writes nothing (an unknown token never creates a phantom row).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type { DownloadTokenRecord, DownloadTokensRepo } from './download-tokens-repo.js';

/** DynamoDB's error name for a failed `ConditionExpression`. */
const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** The slice of the document client this repo uses — injectable so the logic is testable against a fake. */
export interface DownloadTokensDocClient {
  send(command: PutCommand | UpdateCommand): Promise<{ Attributes?: Record<string, unknown> }>;
}

export class DdbDownloadTokensRepo implements DownloadTokensRepo {
  private readonly doc: DownloadTokensDocClient;

  constructor(
    private readonly tableName: string,
    doc?: DownloadTokensDocClient,
  ) {
    this.doc =
      doc ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }) as unknown as DownloadTokensDocClient);
  }

  async create(record: DownloadTokenRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          token: record.token,
          s3Key: record.s3Key,
          filename: record.filename,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          emailId: record.emailId,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          ttl: record.ttl,
          revoked: record.revoked,
          downloadCount: record.downloadCount,
          ...(record.maxDownloads !== undefined ? { maxDownloads: record.maxDownloads } : {}),
        },
        // `#tk` because we also reference the key attribute; guards against clobbering a
        // collision (the secret token can't collide in practice, but fail safe anyway).
        ConditionExpression: 'attribute_not_exists(#tk)',
        ExpressionAttributeNames: { '#tk': 'token' },
      }),
    );
  }

  async claim(token: string, nowIso: string): Promise<DownloadTokenRecord | null> {
    try {
      const out = (await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { token },
          // Atomic gate + consume. `expiresAt > :now` is a lexicographic string compare,
          // which is correct because ISO-8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`) is fixed-width
          // and sorts chronologically. A missing item fails `attribute_exists(#tk)` (so no
          // phantom row is created); `if_not_exists` guards a (never-expected) missing counter.
          UpdateExpression: 'SET downloadCount = if_not_exists(downloadCount, :zero) + :one',
          ConditionExpression:
            'attribute_exists(#tk) AND revoked = :false AND expiresAt > :now AND ' +
            '(attribute_not_exists(maxDownloads) OR downloadCount < maxDownloads)',
          ExpressionAttributeNames: { '#tk': 'token' },
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':false': false, ':now': nowIso },
          ReturnValues: 'ALL_NEW',
        }),
      )) as UpdateCommandOutput;
      return toRecord(out.Attributes);
    } catch (err) {
      // Any gate failure (missing / revoked / expired / exhausted) → uniform "no".
      if (err instanceof Error && err.name === CONDITIONAL_CHECK_FAILED) {
        return null;
      }
      throw err;
    }
  }
}

function toRecord(item: Record<string, unknown> | undefined): DownloadTokenRecord | null {
  if (
    !item ||
    typeof item.token !== 'string' ||
    typeof item.s3Key !== 'string' ||
    typeof item.filename !== 'string' ||
    typeof item.contentType !== 'string' ||
    typeof item.sizeBytes !== 'number' ||
    typeof item.emailId !== 'string' ||
    typeof item.createdAt !== 'string' ||
    typeof item.expiresAt !== 'string' ||
    typeof item.ttl !== 'number' ||
    typeof item.revoked !== 'boolean' ||
    typeof item.downloadCount !== 'number'
  ) {
    return null;
  }
  return {
    token: item.token,
    s3Key: item.s3Key,
    filename: item.filename,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    emailId: item.emailId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    ttl: item.ttl,
    revoked: item.revoked,
    downloadCount: item.downloadCount,
    ...(typeof item.maxDownloads === 'number' ? { maxDownloads: item.maxDownloads } : {}),
  };
}
