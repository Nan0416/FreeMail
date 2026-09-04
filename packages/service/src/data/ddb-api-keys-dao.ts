/**
 * DynamoDB-backed {@link ApiKeysDao} over #2's `apiKeysTable` (partition key
 * `keyId`, no sort key). One row per key:
 *   { keyId, secretHash, name?, createdAt }
 *
 * Create is a conditional put (`attribute_not_exists(keyId)`) so a keyId collision
 * can never clobber an existing key. List is a paginated scan — a single-tenant
 * deployment holds only a handful of keys, so there is no GSI to maintain.
 */
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ApiKeysDao,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  DeleteApiKeyInput,
  GetApiKeyInput,
  GetApiKeyOutput,
} from './api-keys-dao.js';
import { ApiKeyEntity, isConditionalCheckFailed } from './entities.js';

export class DdbApiKeysDao implements ApiKeysDao {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = doc;
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyOutput> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            keyId: input.keyId,
            secretHash: input.secretHash,
            createdAt: input.createdAt,
            ...(input.name !== null ? { name: input.name } : {}),
          },
          ConditionExpression: 'attribute_not_exists(keyId)',
        }),
      );
      return { created: true };
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return { created: false };
      }
      throw error;
    }
  }

  async getApiKey({ keyId }: GetApiKeyInput): Promise<GetApiKeyOutput | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: ApiKeyEntity.key(keyId) }),
    );
    return toRecord(result.Item);
  }

  async listApiKeys(): Promise<ReadonlyArray<GetApiKeyOutput>> {
    const records: GetApiKeyOutput[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.doc.send(
        new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: lastKey }),
      );
      for (const item of result.Items ?? []) {
        const record = toRecord(item);
        if (record) {
          records.push(record);
        }
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return records;
  }

  async deleteApiKey({ keyId }: DeleteApiKeyInput): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: ApiKeyEntity.key(keyId) }),
    );
  }
}

function toRecord(item: Record<string, unknown> | undefined): GetApiKeyOutput | null {
  if (
    !item ||
    typeof item.keyId !== 'string' ||
    typeof item.secretHash !== 'string' ||
    typeof item.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    keyId: item.keyId,
    secretHash: item.secretHash,
    createdAt: item.createdAt,
    name: typeof item.name === 'string' ? item.name : null,
  };
}
