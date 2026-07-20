import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { isLockedOut } from '../../src/auth/lockout.js';
import { DdbAuthRepo, type AuthDocClient } from '../../src/data/ddb-auth-repo.js';

const NOW = 1_700_000_000;

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function keyOf(item: Record<string, unknown> | undefined): string {
  return `${item?.pk}|${item?.sk}`;
}

/**
 * In-memory DynamoDB document client that faithfully honors the conditional-put
 * expressions this repo uses, so the versioned CAS (create vs update guard, retry,
 * and no-resurrection-after-delete) can be tested without AWS.
 */
class FakeDoc implements AuthDocClient {
  readonly store = new Map<string, Record<string, unknown>>();
  readonly puts: PutCommandInput[] = [];
  private readonly beforePutHooks: Array<() => void> = [];

  /** Run `fn` immediately before the next PutCommand — models a concurrent mutation. */
  onceBeforePut(fn: () => void): void {
    this.beforePutHooks.push(fn);
  }

  send(command: GetCommand | PutCommand | DeleteCommand): Promise<{
    Item?: Record<string, unknown>;
    Attributes?: Record<string, unknown>;
  }> {
    if (command instanceof GetCommand) {
      return Promise.resolve({ Item: this.store.get(keyOf(command.input.Key)) });
    }
    if (command instanceof PutCommand) {
      this.beforePutHooks.shift()?.();
      const input = command.input;
      this.puts.push(input);
      const item = input.Item as Record<string, unknown>;
      const existing = this.store.get(keyOf(item));
      if (!this.conditionHolds(input, existing)) {
        return Promise.reject(conditionalCheckFailed());
      }
      this.store.set(keyOf(item), item);
      return Promise.resolve({});
    }
    if (command instanceof DeleteCommand) {
      const key = keyOf(command.input.Key);
      const existing = this.store.get(key);
      this.store.delete(key);
      return Promise.resolve(
        command.input.ReturnValues === 'ALL_OLD' ? { Attributes: existing } : {},
      );
    }
    if (command instanceof UpdateCommand) {
      // Models the lockout reset: SET count/window 0, ADD version 1, REMOVE lockedUntil.
      const key = keyOf(command.input.Key);
      const existing = this.store.get(key) ?? { ...command.input.Key };
      const names = command.input.ExpressionAttributeNames ?? {};
      const values = command.input.ExpressionAttributeValues ?? {};
      const versionAttr = names['#v'];
      const currentVersion = typeof existing[versionAttr] === 'number' ? existing[versionAttr] : 0;
      const next = { ...existing };
      next.failedCount = values[':zero'];
      next.windowStartedAt = values[':zero'];
      next[versionAttr] = (currentVersion as number) + (values[':one'] as number);
      delete next.lockedUntil;
      this.store.set(key, next);
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unsupported command'));
  }

  private conditionHolds(
    input: PutCommandInput,
    existing: Record<string, unknown> | undefined,
  ): boolean {
    const expr = input.ConditionExpression;
    if (!expr) {
      return true;
    }
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    if (expr === 'attribute_not_exists(pk)') {
      return existing === undefined;
    }
    if (expr === 'attribute_not_exists(#v)') {
      return existing === undefined || existing[names['#v']] === undefined;
    }
    if (expr === '#v = :expected') {
      return existing !== undefined && existing[names['#v']] === values[':expected'];
    }
    throw new Error(`unsupported condition: ${expr}`);
  }
}

function seedLockout(doc: FakeDoc, state: Record<string, unknown>): void {
  doc.store.set('auth|lockout', { pk: 'auth', sk: 'lockout', windowStartedAt: NOW, ...state });
}

describe('DdbAuthRepo — password', () => {
  it('creates the password only on first run', async () => {
    const doc = new FakeDoc();
    const repo = new DdbAuthRepo('t', doc);
    expect(await repo.createPasswordHash('hash-1')).toBe(true);
    expect(await repo.createPasswordHash('hash-2')).toBe(false);
    expect(await repo.getPasswordHash()).toBe('hash-1');
  });
});

describe('DdbAuthRepo — lockout CAS', () => {
  it('creates the row with the create guard on the first failure', async () => {
    const doc = new FakeDoc();
    const repo = new DdbAuthRepo('t', doc);

    const committed = await repo.registerFailedAttempt(NOW);

    expect(committed.failedCount).toBe(1);
    expect(doc.puts).toHaveLength(1);
    expect(doc.puts[0].ConditionExpression).toBe('attribute_not_exists(#v)');
    expect(doc.store.get('auth|lockout')?.version).toBe(1);
  });

  it('increments an existing row with a version-matched update guard', async () => {
    const doc = new FakeDoc();
    seedLockout(doc, { failedCount: 2, version: 3 });
    const repo = new DdbAuthRepo('t', doc);

    const committed = await repo.registerFailedAttempt(NOW);

    expect(committed.failedCount).toBe(3);
    expect(doc.puts[0].ConditionExpression).toBe('#v = :expected');
    expect(doc.puts[0].ExpressionAttributeValues?.[':expected']).toBe(3);
    expect(doc.store.get('auth|lockout')?.version).toBe(4);
  });

  it('locks once the threshold is reached across sequential failures', async () => {
    const doc = new FakeDoc();
    const repo = new DdbAuthRepo('t', doc);

    let last = await repo.registerFailedAttempt(NOW);
    for (let i = 1; i < 5; i += 1) {
      last = await repo.registerFailedAttempt(NOW + i);
    }
    expect(last.failedCount).toBe(5);
    expect(isLockedOut(last, NOW + 4)).toBe(true);
  });

  it('retries on a version conflict and commits against the latest state', async () => {
    const doc = new FakeDoc();
    seedLockout(doc, { failedCount: 1, version: 1 });
    const repo = new DdbAuthRepo('t', doc);

    // A concurrent failure lands between our read and our write.
    doc.onceBeforePut(() => seedLockout(doc, { failedCount: 2, version: 2 }));

    const committed = await repo.registerFailedAttempt(NOW);

    expect(doc.puts).toHaveLength(2);
    expect(committed.failedCount).toBe(3);
    expect(doc.store.get('auth|lockout')?.version).toBe(3);
  });

  it('advances the version and resets the counters on clear', async () => {
    const doc = new FakeDoc();
    const repo = new DdbAuthRepo('t', doc);
    await repo.registerFailedAttempt(NOW); // version 1
    await repo.registerFailedAttempt(NOW); // version 2

    await repo.clearLockout();

    const row = doc.store.get('auth|lockout');
    expect(row?.version).toBe(3);
    expect(row?.failedCount).toBe(0);
    expect(row?.lockedUntil).toBeUndefined();
  });

  it('does not resurrect a stale count when a clear advances the version mid-flight', async () => {
    const doc = new FakeDoc();
    seedLockout(doc, { failedCount: 4, version: 5 });
    const repo = new DdbAuthRepo('t', doc);

    // A successful login's reset advances the version between our read (count 4) and
    // our write — the exact interleaving powerbanana flagged.
    doc.onceBeforePut(() => {
      void repo.clearLockout();
    });

    const committed = await repo.registerFailedAttempt(NOW);

    // The stale count-5 write fails the version guard, retries against the reset
    // (count 0) state, and applies a fresh window — never the resurrected count 5.
    expect(committed.failedCount).toBe(1);
    expect(committed.lockedUntil).toBeUndefined();
    expect(doc.puts).toHaveLength(2);
    expect(doc.puts.every((put) => put.ConditionExpression === '#v = :expected')).toBe(true);
    expect(doc.store.get('auth|lockout')?.version).toBe(7);
  });

  it('retries a stale update against an absent row as a fresh create (split guard)', async () => {
    const doc = new FakeDoc();
    seedLockout(doc, { failedCount: 4, version: 5 });
    const repo = new DdbAuthRepo('t', doc);

    // Defense in depth: if the row is absent at write time, the version-matched
    // update fails and the retry falls to the create guard with a fresh count 1.
    doc.onceBeforePut(() => doc.store.delete('auth|lockout'));

    const committed = await repo.registerFailedAttempt(NOW);

    expect(committed.failedCount).toBe(1);
    expect(doc.store.get('auth|lockout')?.version).toBe(1);
    expect(doc.puts[0].ConditionExpression).toBe('#v = :expected');
    expect(doc.puts[1].ConditionExpression).toBe('attribute_not_exists(#v)');
  });
});
