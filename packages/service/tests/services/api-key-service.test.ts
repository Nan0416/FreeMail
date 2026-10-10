import { beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '../../src/utils/errors.js';
import type {
  ApiKeysDao,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  DeleteApiKeyInput,
  DeleteApiKeyOutput,
  GetApiKeyInput,
  GetApiKeyOutput,
  ListApiKeysOutput,
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
  getApiKey(input: GetApiKeyInput): Promise<GetApiKeyOutput | null> {
    return Promise.resolve(this.rows.get(input.keyId) ?? null);
  }
  listApiKeys(): Promise<ListApiKeysOutput> {
    return Promise.resolve({ apiKeys: [...this.rows.values()] });
  }
  deleteApiKey(input: DeleteApiKeyInput): Promise<DeleteApiKeyOutput> {
    this.rows.delete(input.keyId);
    return Promise.resolve({});
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
    const result = await service.createApiKey({ name: 'CI deploy bot' });

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
    expect((await service.createApiKey({})).name).toBeNull();
    expect((await service.createApiKey({ name: '   ' })).name).toBeNull();
  });

  it('rejects a name over the max length', async () => {
    await expect(service.createApiKey({ name: 'x'.repeat(101) })).rejects.toBeInstanceOf(AuthError);
  });

  it('retries on a keyId collision and still succeeds', async () => {
    repo.collideNext = 2;
    const result = await service.createApiKey({});
    expect(repo.rows.has(result.id)).toBe(true);
  });
});

describe('ApiKeyService.list', () => {
  it('returns summaries newest-first and never the secret', async () => {
    service = new ApiKeyService({ apiKeysDao: repo, now: () => NOW });
    const first = await service.createApiKey({ name: 'first' });
    service = new ApiKeyService({ apiKeysDao: repo, now: () => NOW + 10 });
    const second = await service.createApiKey({ name: 'second' });

    const result = await service.listApiKeys({});
    expect(result.keys.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(result.keys)).not.toContain(first.key);
    expect(JSON.stringify(result.keys)).not.toContain(second.key);
    // Summaries carry no secret material at all.
    for (const summary of result.keys) {
      expect(Object.keys(summary).sort()).toEqual(['createdAt', 'id', 'name']);
    }
  });
});

describe('ApiKeyService.revoke', () => {
  it('deletes a key and is idempotent on an unknown id', async () => {
    const created = await service.createApiKey({});
    await service.revokeApiKey({ keyId: created.id });
    expect(repo.rows.has(created.id)).toBe(false);
    await expect(service.revokeApiKey({ keyId: 'nonexistent' })).resolves.toBeUndefined();
  });
});

describe('ApiKeyService.verify', () => {
  it('accepts a valid key and returns its keyId', async () => {
    const created = await service.createApiKey({});
    expect(await service.verifyApiKey({ rawKey: created.key })).toEqual({ keyId: created.id });
  });

  it('rejects a malformed, unknown, or revoked key', async () => {
    const created = await service.createApiKey({});
    expect(await service.verifyApiKey({ rawKey: 'not-a-key' })).toBeNull();
    expect(await service.verifyApiKey({ rawKey: 'fm_deadbeef_missing' })).toBeNull();
    await service.revokeApiKey({ keyId: created.id });
    expect(await service.verifyApiKey({ rawKey: created.key })).toBeNull();
  });

  it('rejects a right keyId with a wrong secret', async () => {
    const created = await service.createApiKey({});
    const forged = `fm_${created.id}_tampered`;
    expect(await service.verifyApiKey({ rawKey: forged })).toBeNull();
  });
});
