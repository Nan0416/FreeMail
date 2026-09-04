import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/utils/errors.js';
import type {
  ApiKeysDao,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  DeleteApiKeyInput,
  GetApiKeyInput,
  GetApiKeyOutput,
} from '../../src/data/api-keys-dao.js';
import { parseApiKey } from '../../src/utils/api-key.js';
import { ApiKeyService } from '../../src/services/api-key-service.js';

class FakeApiKeysDao implements ApiKeysDao {
  readonly rows = new Map<string, GetApiKeyOutput>();
  /** When set, the next N createApiKey() calls report a collision. */
  collideNext = 0;

  createApiKey(record: CreateApiKeyInput): Promise<CreateApiKeyOutput> {
    if (this.collideNext > 0) {
      this.collideNext -= 1;
      return Promise.resolve({ created: false });
    }
    if (this.rows.has(record.keyId)) {
      return Promise.resolve({ created: false });
    }
    this.rows.set(record.keyId, record);
    return Promise.resolve({ created: true });
  }
  getApiKey({ keyId }: GetApiKeyInput): Promise<GetApiKeyOutput | null> {
    return Promise.resolve(this.rows.get(keyId) ?? null);
  }
  listApiKeys(): Promise<ReadonlyArray<GetApiKeyOutput>> {
    return Promise.resolve([...this.rows.values()]);
  }
  deleteApiKey({ keyId }: DeleteApiKeyInput): Promise<void> {
    this.rows.delete(keyId);
    return Promise.resolve();
  }
}

const NOW = 1_700_000_000;

let repo: FakeApiKeysDao;
let service: ApiKeyService;

beforeEach(() => {
  repo = new FakeApiKeysDao();
  service = new ApiKeyService({ apiKeysDao: repo, now: () => NOW });
});

describe('ApiKeyService.create', () => {
  it('returns the raw key once and persists only its hash', async () => {
    const result = await service.create({ name: 'CI deploy bot' });

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
    expect((await service.create({})).name).toBeNull();
    expect((await service.create({ name: '   ' })).name).toBeNull();
  });

  it('rejects a name over the max length', async () => {
    await expect(service.create({ name: 'x'.repeat(101) })).rejects.toBeInstanceOf(AuthError);
  });

  it('retries on a keyId collision and still succeeds', async () => {
    repo.collideNext = 2;
    const result = await service.create({});
    expect(repo.rows.has(result.id)).toBe(true);
  });
});

describe('ApiKeyService.list', () => {
  it('returns summaries newest-first and never the secret', async () => {
    service = new ApiKeyService({ apiKeysDao: repo, now: () => NOW });
    const first = await service.create({ name: 'first' });
    service = new ApiKeyService({ apiKeysDao: repo, now: () => NOW + 10 });
    const second = await service.create({ name: 'second' });

    const { keys: summaries } = await service.list({});
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
    const created = await service.create({});
    await service.revoke({ keyId: created.id });
    expect(repo.rows.has(created.id)).toBe(false);
    await expect(service.revoke({ keyId: 'nonexistent' })).resolves.toBeUndefined();
  });
});

describe('ApiKeyService.verify', () => {
  it('accepts a valid key and returns its keyId', async () => {
    const created = await service.create({});
    expect(await service.verify({ rawKey: created.key })).toEqual({ keyId: created.id });
  });

  it('rejects a malformed, unknown, or revoked key', async () => {
    const created = await service.create({});
    expect(await service.verify({ rawKey: 'not-a-key' })).toBeNull();
    expect(await service.verify({ rawKey: 'fm_deadbeef_missing' })).toBeNull();
    await service.revoke({ keyId: created.id });
    expect(await service.verify({ rawKey: created.key })).toBeNull();
  });

  it('rejects a right keyId with a wrong secret', async () => {
    const created = await service.create({});
    const forged = `fm_${created.id}_tampered`;
    expect(await service.verify({ rawKey: forged })).toBeNull();
  });
});
