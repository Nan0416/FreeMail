/**
 * DynamoDB-backed {@link ApiKeysRepo} over #2's `apiKeysTable` (partition key
 * `keyId`, no sort key). One row per key:
 *   { keyId, secretHash, name?, createdAt }
 *
 * Create is a conditional put (`attribute_not_exists(keyId)`) so a keyId collision
 * can never clobber an existing key. List is a paginated scan — a single-tenant
 * deployment holds only a handful of keys, so there is no GSI to maintain.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ApiKeyRecord, ApiKeysRepo } from './keys-repo.js';

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** The slice of the DynamoDB document client this repo uses — injectable so the logic is testable against a fake. */
export interface ApiKeysDocClient {
  send(command: GetCommand | PutCommand | DeleteCommand | ScanCommand): Promise<{
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  }>;
}

export class DdbApiKeysRepo implements ApiKeysRepo {
  private readonly doc: ApiKeysDocClient;

  constructor(
    private readonly tableName: string,
    doc?: ApiKeysDocClient,
  ) {
    this.doc =
      doc ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }) as unknown as ApiKeysDocClient);
  }

  async create(record: ApiKeyRecord): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            keyId: record.keyId,
            secretHash: record.secretHash,
            createdAt: record.createdAt,
            ...(record.name !== null ? { name: record.name } : {}),
          },
          ConditionExpression: 'attribute_not_exists(keyId)',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  async getByKeyId(keyId: string): Promise<ApiKeyRecord | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { keyId } }),
    );
    return toRecord(result.Item);
  }

  async list(): Promise<ApiKeyRecord[]> {
    const records: ApiKeyRecord[] = [];
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

  async delete(keyId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { keyId } }));
  }
}

function toRecord(item: Record<string, unknown> | undefined): ApiKeyRecord | null {
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
