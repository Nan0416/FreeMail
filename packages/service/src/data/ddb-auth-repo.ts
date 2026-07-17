/**
 * DynamoDB-backed {@link AuthRepo} over #2's single-table `authTable` (pk/sk,
 * `ttl` attribute). Layout:
 *   - password  → pk `auth`, sk `password`   { hash }
 *   - lockout   → pk `auth`, sk `lockout`     { failedCount, windowStartedAt, lockedUntil?, version, ttl }
 *   - refresh   → pk `refresh`, sk `<hash>`   { ttl }
 *
 * The lockout row carries a `version` so failed-attempt increments are a versioned
 * compare-and-swap (see {@link registerFailedAttempt}) rather than a lost-update-
 * prone read-modify-write.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  FAILURE_WINDOW_SECONDS,
  INITIAL_LOCKOUT_STATE,
  LOCKOUT_SECONDS,
  registerFailure,
} from '../auth/lockout.js';
import type { LockoutState } from '../auth/lockout.js';
import { optimisticUpdate, type VersionedValue } from './optimistic.js';
import type { AuthRepo } from './auth-repo.js';

const PASSWORD_KEY = { pk: 'auth', sk: 'password' } as const;
const LOCKOUT_KEY = { pk: 'auth', sk: 'lockout' } as const;
const REFRESH_PK = 'refresh';

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** The slice of the DynamoDB document client this repo uses — injectable so the CAS logic is testable against a fake. */
export interface AuthDocClient {
  send(command: GetCommand | PutCommand | DeleteCommand): Promise<{
    Item?: Record<string, unknown>;
    Attributes?: Record<string, unknown>;
  }>;
}

export class DdbAuthRepo implements AuthRepo {
  private readonly doc: AuthDocClient;

  constructor(
    private readonly tableName: string,
    doc?: AuthDocClient,
  ) {
    this.doc =
      doc ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }) as unknown as AuthDocClient);
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
    return (await this.readLockout()).value;
  }

  async registerFailedAttempt(nowSeconds: number): Promise<LockoutState> {
    // Keep the row until any window + lock it could still enforce has elapsed.
    const ttl = nowSeconds + FAILURE_WINDOW_SECONDS + LOCKOUT_SECONDS;
    return optimisticUpdate<LockoutState>(
      () => this.readLockout(),
      (current) => registerFailure(current ?? INITIAL_LOCKOUT_STATE, nowSeconds),
      (next, expectedVersion) => this.writeLockoutIfVersion(next, ttl, expectedVersion),
    );
  }

  async clearLockout(): Promise<void> {
    // Unconditional delete: a successful login is an authoritative reset. A failure
    // that read the row before this delete cannot resurrect the old count — its
    // version-guarded update (below) fails against the now-absent row and retries
    // into a fresh window (count 1) — so clearing can never undercount.
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: LOCKOUT_KEY }));
  }

  private async readLockout(): Promise<VersionedValue<LockoutState>> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: LOCKOUT_KEY }),
    );
    const item = result.Item;
    if (!item || typeof item.failedCount !== 'number') {
      return { value: null, version: 0 };
    }
    return {
      value: {
        failedCount: item.failedCount,
        windowStartedAt: typeof item.windowStartedAt === 'number' ? item.windowStartedAt : 0,
        ...(typeof item.lockedUntil === 'number' ? { lockedUntil: item.lockedUntil } : {}),
      },
      version: typeof item.version === 'number' ? item.version : 0,
    };
  }

  private async writeLockoutIfVersion(
    next: LockoutState,
    ttlEpochSeconds: number,
    expectedVersion: number,
  ): Promise<boolean> {
    // Guard split by what we read, so the create path can't be abused by a stale
    // reader. A read of an absent row (version 0) may only *create* it, and fails if
    // anyone created it meanwhile. A read of an existing row must match that exact
    // version — it deliberately does NOT fall back to attribute_not_exists, so a
    // snapshot taken before a clear() delete cannot resurrect the stale count: its
    // update fails against the absent row, retries, and starts a fresh window.
    const guard =
      expectedVersion === 0
        ? { ConditionExpression: 'attribute_not_exists(#v)' }
        : {
            ConditionExpression: '#v = :expected',
            ExpressionAttributeValues: { ':expected': expectedVersion },
          };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...LOCKOUT_KEY, ...next, version: expectedVersion + 1, ttl: ttlEpochSeconds },
          ExpressionAttributeNames: { '#v': 'version' },
          ...guard,
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
