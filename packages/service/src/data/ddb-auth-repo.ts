/**
 * DynamoDB-backed {@link AuthRepo} over #2's single-table `authTable` (pk/sk,
 * `ttl` attribute). Layout:
 *   - password  → pk `auth`, sk `password`   { hash }
 *   - lockout   → pk `auth`, sk `lockout`     { failedCount, windowStartedAt, lockedUntil?, version }
 *   - refresh   → pk `refresh`, sk `<hash>`   { ttl }
 *
 * The single lockout row carries a monotonic `version`: failed-attempt increments
 * are a versioned compare-and-swap, and the success reset ADVANCES the version too
 * (never deletes), so a stale pre-reset writer can never resurrect the old count.
 * The row has no TTL — it's one tiny permanent row, and staleness is handled in the
 * policy (an elapsed window resets the count), so the version never regresses.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { INITIAL_LOCKOUT_STATE, registerFailure } from '../auth/lockout.js';
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
  send(command: GetCommand | PutCommand | DeleteCommand | UpdateCommand): Promise<{
    readonly Item?: Record<string, unknown>;
    readonly Attributes?: Record<string, unknown>;
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
    return optimisticUpdate<LockoutState>(
      () => this.readLockout(),
      (current) => registerFailure(current ?? INITIAL_LOCKOUT_STATE, nowSeconds),
      (next, expectedVersion) => this.writeLockoutIfVersion(next, expectedVersion),
    );
  }

  async clearLockout(): Promise<void> {
    // A successful login resets the counters AND advances the version in one atomic
    // update (never a delete). Advancing the version is what makes the reset safe: a
    // concurrent failure that read the pre-reset version now fails its version-guarded
    // put, retries, re-reads the cleared state, and applies to a fresh window (count 1)
    // — it can neither resurrect the old count nor undercount.
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: LOCKOUT_KEY,
        UpdateExpression:
          'SET failedCount = :zero, windowStartedAt = :zero ADD #v :one REMOVE lockedUntil',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }),
    );
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
    expectedVersion: number,
  ): Promise<boolean> {
    // Guard split by what we read. A read of an absent row (version 0 — only the
    // first-ever write, since the reset advances rather than deletes) may only
    // *create* it. A read of an existing row must match that exact version and does
    // NOT fall back to attribute_not_exists, so a stale snapshot can never resurrect
    // a count: it fails, retries, and re-reads the current (possibly reset) state.
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
          Item: { ...LOCKOUT_KEY, ...next, version: expectedVersion + 1 },
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
