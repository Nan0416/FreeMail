/**
 * DynamoDB-backed {@link DownloadTokensDao} over #2's `downloadTokensTable`
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
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import type {
  ClaimDownloadTokenInput,
  CreateDownloadTokenInput,
  DownloadTokensDao,
  GetDownloadTokenOutput,
} from './download-tokens-dao.js';
import { CONDITIONAL_CHECK_FAILED, DownloadTokenEntity } from './entities.js';

export class DdbDownloadTokensDao implements DownloadTokensDao {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = doc;
  }

  async createDownloadToken(input: CreateDownloadTokenInput): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          token: input.token,
          s3Key: input.s3Key,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          emailId: input.emailId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          ttl: input.ttl,
          revoked: input.revoked,
          downloadCount: input.downloadCount,
          ...(input.maxDownloads !== undefined ? { maxDownloads: input.maxDownloads } : {}),
        },
        // `#tk` because we also reference the key attribute; guards against clobbering a
        // collision (the secret token can't collide in practice, but fail safe anyway).
        ConditionExpression: 'attribute_not_exists(#tk)',
        ExpressionAttributeNames: { '#tk': 'token' },
      }),
    );
  }

  async claimDownloadToken({
    token,
    nowIso,
  }: ClaimDownloadTokenInput): Promise<GetDownloadTokenOutput | null> {
    try {
      const out = (await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: DownloadTokenEntity.key(token),
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

function toRecord(item: Record<string, unknown> | undefined): GetDownloadTokenOutput | null {
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
