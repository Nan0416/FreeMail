/**
 * DynamoDB-backed {@link AuthRepo} over #2's single-table `authTable` (pk/sk,
 * `ttl` attribute). Layout:
 *   - password  → pk `auth`, sk `password`   { hash }
 *   - lockout   → pk `auth`, sk `lockout`     { failedCount, windowStartedAt, lockedUntil?, ttl }
 *   - refresh   → pk `refresh`, sk `<hash>`   { ttl }
 *
 * The AWS SDK v3 clients are provided by the Lambda Node runtime and marked
 * external in the bundle, so nothing here is shipped in the function zip.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type { LockoutState } from '../auth/lockout.js';
import type { AuthRepo } from './auth-repo.js';

const PASSWORD_KEY = { pk: 'auth', sk: 'password' } as const;
const LOCKOUT_KEY = { pk: 'auth', sk: 'lockout' } as const;
const REFRESH_PK = 'refresh';

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ConditionalCheckFailedException';
}

export class DdbAuthRepo implements AuthRepo {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createPasswordHash(hash: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...PASSWORD_KEY, hash },
          ConditionExpression: 'attribute_not_exists(pk)',
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

  async getPasswordHash(): Promise<string | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: PASSWORD_KEY }),
    );
    const hash = result.Item?.hash;
    return typeof hash === 'string' ? hash : null;
  }

  async getLockout(): Promise<LockoutState | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: LOCKOUT_KEY }),
    );
    const item = result.Item;
    if (!item || typeof item.failedCount !== 'number') {
      return null;
    }
    return {
      failedCount: item.failedCount,
      windowStartedAt: typeof item.windowStartedAt === 'number' ? item.windowStartedAt : 0,
      ...(typeof item.lockedUntil === 'number' ? { lockedUntil: item.lockedUntil } : {}),
    };
  }

  async putLockout(state: LockoutState, ttlEpochSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...LOCKOUT_KEY, ...state, ttl: ttlEpochSeconds },
      }),
    );
  }

  async clearLockout(): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: LOCKOUT_KEY }));
  }

  async putRefreshToken(tokenHash: string, ttlEpochSeconds: number): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: REFRESH_PK, sk: tokenHash, ttl: ttlEpochSeconds },
      }),
    );
  }

  async consumeRefreshToken(tokenHash: string): Promise<boolean> {
    const result = await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: REFRESH_PK, sk: tokenHash },
        ReturnValues: 'ALL_OLD',
      }),
    );
    // A refresh row may have out-lived its logical TTL (DynamoDB deletes lazily),
    // so honor the stored ttl and treat an expired row as already gone.
    const item = result.Attributes;
    if (!item) {
      return false;
    }
    if (typeof item.ttl === 'number' && item.ttl <= Math.floor(Date.now() / 1000)) {
      return false;
    }
    return true;
  }
}
