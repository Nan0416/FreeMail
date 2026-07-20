import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/errors.js';
import type { ApiKeyRecord, ApiKeysRepo } from '../../src/data/keys-repo.js';
import { parseApiKey } from '../../src/keys/api-key.js';
import { ApiKeyService } from '../../src/keys/service.js';

class FakeApiKeysRepo implements ApiKeysRepo {
  readonly rows = new Map<string, ApiKeyRecord>();
  /** When set, the next N create() calls report a collision (false). */
  collideNext = 0;

  create(record: ApiKeyRecord): Promise<boolean> {
    if (this.collideNext > 0) {
      this.collideNext -= 1;
      return Promise.resolve(false);
    }
    if (this.rows.has(record.keyId)) {
      return Promise.resolve(false);
    }
    this.rows.set(record.keyId, record);
    return Promise.resolve(true);
  }
  getByKeyId(keyId: string): Promise<ApiKeyRecord | null> {
    return Promise.resolve(this.rows.get(keyId) ?? null);
  }
  list(): Promise<ApiKeyRecord[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  delete(keyId: string): Promise<void> {
    this.rows.delete(keyId);
    return Promise.resolve();
  }
}

const NOW = 1_700_000_000;

let repo: FakeApiKeysRepo;
let service: ApiKeyService;

beforeEach(() => {
  repo = new FakeApiKeysRepo();
  service = new ApiKeyService({ repo, now: () => NOW });
});

describe('ApiKeyService.create', () => {
  it('returns the raw key once and persists only its hash', async () => {
    const result = await service.create('CI deploy bot');

    expect(result.key.startsWith('fm_')).toBe(true);
    expect(result.name).toBe('CI deploy bot');
    expect(result.id).toBe(parseApiKey(result.key)?.keyId);
    expect(result.createdAt).toBe(new Date(NOW * 1000).toISOString());

    const stored = repo.rows.get(result.id);
    expect(stored).toBeDefined();
    // Only the hash is stored — never the raw key or secret.
    expect(stored?.secretHash).not.toContain(parseApiKey(result.key)?.secret);
    expect(JSON.stringify(stored)).not.toContain(result.key);
  });

  it('stores an unnamed key as name null (trimming blank names)', async () => {
    expect((await service.create()).name).toBeNull();
    expect((await service.create('   ')).name).toBeNull();
  });

  it('rejects a name over the max length', async () => {
    await expect(service.create('x'.repeat(101))).rejects.toBeInstanceOf(AuthError);
  });

  it('retries on a keyId collision and still succeeds', async () => {
    repo.collideNext = 2;
    const result = await service.create();
    expect(repo.rows.has(result.id)).toBe(true);
  });
});

describe('ApiKeyService.list', () => {
  it('returns summaries newest-first and never the secret', async () => {
    service = new ApiKeyService({ repo, now: () => NOW });
    const first = await service.create('first');
    service = new ApiKeyService({ repo, now: () => NOW + 10 });
    const second = await service.create('second');

    const summaries = await service.list();
    expect(summaries.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(summaries)).not.toContain(first.key);
    expect(JSON.stringify(summaries)).not.toContain(second.key);
    // Summaries carry no secret material at all.
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(['createdAt', 'id', 'name']);
    }
  });
});

describe('ApiKeyService.revoke', () => {
  it('deletes a key and is idempotent on an unknown id', async () => {
    const created = await service.create();
    await service.revoke(created.id);
    expect(repo.rows.has(created.id)).toBe(false);
    await expect(service.revoke('nonexistent')).resolves.toBeUndefined();
  });
});

describe('ApiKeyService.verify', () => {
  it('accepts a valid key and returns its keyId', async () => {
    const created = await service.create();
    expect(await service.verify(created.key)).toBe(created.id);
  });

  it('rejects a malformed, unknown, or revoked key', async () => {
    const created = await service.create();
    expect(await service.verify('not-a-key')).toBeNull();
    expect(await service.verify('fm_deadbeef_missing')).toBeNull();
    await service.revoke(created.id);
    expect(await service.verify(created.key)).toBeNull();
  });

  it('rejects a right keyId with a wrong secret', async () => {
    const created = await service.create();
    const forged = `fm_${created.id}_tampered`;
    expect(await service.verify(forged)).toBeNull();
  });
});
