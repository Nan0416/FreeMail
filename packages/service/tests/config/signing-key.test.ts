import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthRepo } from '../../src/data/auth-repo.js';
import {
  getOrCreateSigningKey,
  getSigningKey,
  resetSigningKeyCache,
} from '../../src/config/signing-key.js';

/**
 * Only the signing-key rows matter here, so the rest of the AuthRepo surface throws —
 * a call to any of it would mean the module reached past what it needs.
 */
class FakeAuthRepo implements AuthRepo {
  key: string | null = null;
  reads = 0;
  creates = 0;
  /** Runs immediately before the conditional create — models a concurrent winner. */
  onBeforeCreate?: () => void;

  getSigningKey(): Promise<string | null> {
    this.reads += 1;
    return Promise.resolve(this.key);
  }

  createSigningKey(key: string): Promise<boolean> {
    this.creates += 1;
    this.onBeforeCreate?.();
    if (this.key !== null) {
      return Promise.resolve(false);
    }
    this.key = key;
    return Promise.resolve(true);
  }

  createPasswordHash(): Promise<boolean> {
    throw new Error('unexpected');
  }
  getPasswordHash(): Promise<string | null> {
    throw new Error('unexpected');
  }
  getLockout(): never {
    throw new Error('unexpected');
  }
  registerFailedAttempt(): never {
    throw new Error('unexpected');
  }
  clearLockout(): Promise<void> {
    throw new Error('unexpected');
  }
  putRefreshToken(): Promise<void> {
    throw new Error('unexpected');
  }
  consumeRefreshToken(): Promise<boolean> {
    throw new Error('unexpected');
  }
}

let repo: FakeAuthRepo;

beforeEach(() => {
  resetSigningKeyCache();
  repo = new FakeAuthRepo();
});

describe('getOrCreateSigningKey', () => {
  it('generates and persists a key on first use', async () => {
    const key = await getOrCreateSigningKey(repo);
    expect(key).toHaveLength(43); // 32 random bytes, base64url, unpadded
    expect(repo.key).toBe(key);
    expect(repo.creates).toBe(1);
  });

  it('returns the persisted key without regenerating it', async () => {
    repo.key = 'already-persisted';
    expect(await getOrCreateSigningKey(repo)).toBe('already-persisted');
    expect(repo.creates).toBe(0);
  });

  it('adopts the winner key when a concurrent cold start claims the row first', async () => {
    repo.onBeforeCreate = () => {
      repo.key = 'winner-key';
    };
    // The generated key loses the conditional write, so it must not be the one returned —
    // signing with it would produce tokens the authorizer could never verify.
    expect(await getOrCreateSigningKey(repo)).toBe('winner-key');
    expect(repo.creates).toBe(1);
  });

  it('caches across calls so a warm invocation does not re-read the table', async () => {
    const first = await getOrCreateSigningKey(repo);
    const readsAfterFirst = repo.reads;
    expect(await getOrCreateSigningKey(repo)).toBe(first);
    expect(repo.reads).toBe(readsAfterFirst);
  });

  it('generates a distinct key per deployment (not a constant)', async () => {
    const a = await getOrCreateSigningKey(repo);
    resetSigningKeyCache();
    const b = await getOrCreateSigningKey(new FakeAuthRepo());
    expect(a).not.toBe(b);
  });
});

describe('getSigningKey (authorizer read path)', () => {
  it('returns null when no key has been generated — the caller fails closed', async () => {
    expect(await getSigningKey(repo)).toBeNull();
    expect(repo.creates).toBe(0);
  });

  it('never writes, even on a cold read', async () => {
    repo.key = 'persisted';
    expect(await getSigningKey(repo)).toBe('persisted');
    expect(repo.creates).toBe(0);
  });

  it('caches a present key but does not cache absence', async () => {
    expect(await getSigningKey(repo)).toBeNull();
    repo.key = 'appeared-later';
    // Absence must not be cached: the REST handler creates the key after this authorizer
    // instance has already served a request, and the warm instance must pick it up.
    expect(await getSigningKey(repo)).toBe('appeared-later');
  });
});
