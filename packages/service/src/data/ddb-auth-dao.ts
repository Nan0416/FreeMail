/**
 * DynamoDB-backed {@link AuthDao} over #2's single-table `authTable` (pk/sk,
 * `ttl` attribute). Layout:
 *   - password → pk `auth`, sk `password`     { hash }
 *   - signing  → pk `auth`, sk `signing-key`  { key, createdAt }
 *   - lockout  → pk `auth`, sk `lockout`      { failedCount, windowStartedAt, lockedUntil?, version }
 *   - refresh  → pk `refresh`, sk `<hash>`    { ttl }
 *
 * The single lockout row carries a monotonic `version`: failed-attempt increments
 * are a versioned compare-and-swap, and the success reset ADVANCES the version too
 * (never deletes), so a stale pre-reset writer can never resurrect the old count.
 * The row has no TTL — it's one tiny permanent row, and staleness is handled in the
 * policy (an elapsed window resets the count), so the version never regresses.
 */
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { INITIAL_LOCKOUT_STATE, registerFailure } from '../utils/lockout.js';
import type { LockoutState } from '../utils/lockout.js';
import { optimisticUpdate, type VersionedValue } from './optimistic.js';
import type {
  AuthDao,
  ClearLockoutInput,
  ClearLockoutOutput,
  ConsumeRefreshTokenInput,
  ConsumeRefreshTokenOutput,
  CreatePasswordHashInput,
  CreatePasswordHashOutput,
  CreateSigningKeyInput,
  CreateSigningKeyOutput,
  GetLockoutInput,
  GetLockoutOutput,
  GetPasswordHashInput,
  GetPasswordHashOutput,
  GetSigningKeyInput,
  GetSigningKeyOutput,
  PutRefreshTokenInput,
  PutRefreshTokenOutput,
  RegisterFailedAttemptInput,
  RegisterFailedAttemptOutput,
} from './auth-dao.js';
import { AuthEntity, isConditionalCheckFailed } from './entities.js';

export class DdbAuthDao implements AuthDao {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = doc;
  }

  async createPasswordHash(input: CreatePasswordHashInput): Promise<CreatePasswordHashOutput> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...AuthEntity.password(), hash: input.hash },
          ConditionExpression: 'attribute_not_exists(pk)',
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

  async getPasswordHash(_input: GetPasswordHashInput): Promise<GetPasswordHashOutput | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: AuthEntity.password() }),
    );
    const hash = result.Item?.hash;
    return typeof hash === 'string' ? { hash } : null;
  }

  async getSigningKey(_input: GetSigningKeyInput): Promise<GetSigningKeyOutput | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: AuthEntity.signingKey() }),
    );
    const key = result.Item?.key;
    return typeof key === 'string' ? { key } : null;
  }

  async createSigningKey(input: CreateSigningKeyInput): Promise<CreateSigningKeyOutput> {
    // Same atomic first-writer-wins idiom as createPasswordHash: the condition is
    // evaluated against THIS item (pk+sk), so it cannot collide with the password row.
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...AuthEntity.signingKey(),
            key: input.key,
            createdAt: Math.floor(Date.now() / 1000),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
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

  async getLockout(_input: GetLockoutInput): Promise<GetLockoutOutput | null> {
    return (await this.readLockout()).value;
  }

  async registerFailedAttempt(
    input: RegisterFailedAttemptInput,
  ): Promise<RegisterFailedAttemptOutput> {
    return optimisticUpdate<LockoutState>(
      () => this.readLockout(),
      (current) => registerFailure(current ?? INITIAL_LOCKOUT_STATE, input.nowSeconds),
      (next, expectedVersion) => this.writeLockoutIfVersion(next, expectedVersion),
    );
  }

  async clearLockout(_input: ClearLockoutInput): Promise<ClearLockoutOutput> {
    // A successful login resets the counters AND advances the version in one atomic
    // update (never a delete). Advancing the version is what makes the reset safe: a
    // concurrent failure that read the pre-reset version now fails its version-guarded
    // put, retries, re-reads the cleared state, and applies to a fresh window (count 1)
    // — it can neither resurrect the old count nor undercount.
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: AuthEntity.lockout(),
        UpdateExpression:
          'SET failedCount = :zero, windowStartedAt = :zero ADD #v :one REMOVE lockedUntil',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      }),
    );
    return {};
  }

  private async readLockout(): Promise<VersionedValue<LockoutState>> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: AuthEntity.lockout() }),
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
          Item: { ...AuthEntity.lockout(), ...next, version: expectedVersion + 1 },
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

  async putRefreshToken(input: PutRefreshTokenInput): Promise<PutRefreshTokenOutput> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...AuthEntity.refreshToken(input.tokenHash), ttl: input.ttlEpochSeconds },
      }),
    );
    return {};
  }

  async consumeRefreshToken(input: ConsumeRefreshTokenInput): Promise<ConsumeRefreshTokenOutput> {
    const result = await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: AuthEntity.refreshToken(input.tokenHash),
        ReturnValues: 'ALL_OLD',
      }),
    );
    // A refresh row may have out-lived its logical TTL (DynamoDB deletes lazily),
    // so honor the stored ttl and treat an expired row as already gone.
    const item = result.Attributes;
    if (!item) {
      return { consumed: false };
    }
    if (typeof item.ttl === 'number' && item.ttl <= Math.floor(Date.now() / 1000)) {
      return { consumed: false };
    }
    return { consumed: true };
  }
}
