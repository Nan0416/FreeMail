import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  type PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbApiKeysRepo, type ApiKeysDocClient } from '../../src/data/ddb-keys-repo.js';
import type { ApiKeyRecord } from '../../src/data/keys-repo.js';

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/**
 * In-memory document client honoring the conditional put and a paginated scan,
 * so the repo's collision guard and multi-page list are exercised without AWS.
 * `scanPageSize` forces the scan to page so the LastEvaluatedKey loop is covered.
 */
class FakeDoc implements ApiKeysDocClient {
  readonly store = new Map<string, Record<string, unknown>>();
  scanPageSize = 100;

  send(command: GetCommand | PutCommand | DeleteCommand | ScanCommand): Promise<{
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  }> {
    if (command instanceof GetCommand) {
      return Promise.resolve({ Item: this.store.get(String(command.input.Key?.keyId)) });
    }
    if (command instanceof PutCommand) {
      const input = command.input;
      const item = input.Item as Record<string, unknown>;
      const key = String(item.keyId);
      if (input.ConditionExpression === 'attribute_not_exists(keyId)' && this.store.has(key)) {
        return Promise.reject(conditionalCheckFailed());
      }
      this.store.set(key, item);
      return Promise.resolve({});
    }
    if (command instanceof DeleteCommand) {
      this.store.delete(String(command.input.Key?.keyId));
      return Promise.resolve({});
    }
    if (command instanceof ScanCommand) {
      const all = [...this.store.values()];
      const start = command.input.ExclusiveStartKey
        ? all.findIndex((i) => i.keyId === command.input.ExclusiveStartKey?.keyId) + 1
        : 0;
      const page = all.slice(start, start + this.scanPageSize);
      const last = page[page.length - 1];
      const more = start + this.scanPageSize < all.length;
      return Promise.resolve({
        Items: page,
        ...(more && last ? { LastEvaluatedKey: { keyId: last.keyId } } : {}),
      });
    }
    return Promise.reject(new Error('unsupported command'));
  }
}

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return { keyId: 'k1', secretHash: 'hash1', name: 'one', createdAt: 100, ...overrides };
}

describe('DdbApiKeysRepo', () => {
  it('creates a key and reads it back, omitting name when null', async () => {
    const doc = new FakeDoc();
    const repo = new DdbApiKeysRepo('t', doc);

    expect(await repo.create(record({ name: null }))).toBe(true);
    const stored = doc.store.get('k1') as PutCommandInput['Item'];
    expect(stored).not.toHaveProperty('name'); // null names are not persisted
    expect(await repo.getByKeyId('k1')).toEqual(record({ name: null }));
  });

  it('refuses to overwrite an existing keyId (collision → false)', async () => {
    const doc = new FakeDoc();
    const repo = new DdbApiKeysRepo('t', doc);
    expect(await repo.create(record({ secretHash: 'first' }))).toBe(true);
    expect(await repo.create(record({ secretHash: 'second' }))).toBe(false);
    expect((await repo.getByKeyId('k1'))?.secretHash).toBe('first');
  });

  it('returns null for an unknown key', async () => {
    const repo = new DdbApiKeysRepo('t', new FakeDoc());
    expect(await repo.getByKeyId('missing')).toBeNull();
  });

  it('lists every key across scan pages', async () => {
    const doc = new FakeDoc();
    doc.scanPageSize = 1; // force pagination
    const repo = new DdbApiKeysRepo('t', doc);
    await repo.create(record({ keyId: 'a', createdAt: 1 }));
    await repo.create(record({ keyId: 'b', createdAt: 2 }));
    await repo.create(record({ keyId: 'c', createdAt: 3 }));

    const ids = (await repo.list()).map((r) => r.keyId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('deletes a key and is a no-op on an unknown id', async () => {
    const doc = new FakeDoc();
    const repo = new DdbApiKeysRepo('t', doc);
    await repo.create(record());
    await repo.delete('k1');
    expect(await repo.getByKeyId('k1')).toBeNull();
    await expect(repo.delete('missing')).resolves.toBeUndefined();
  });
});
