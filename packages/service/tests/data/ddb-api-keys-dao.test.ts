import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  type PutCommandInput,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbApiKeysDao } from '../../src/data/ddb-api-keys-dao.js';
import type { GetApiKeyOutput } from '../../src/data/api-keys-dao.js';

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/**
 * In-memory document client honoring the conditional put and a paginated scan,
 * so the dao's collision guard and multi-page list are exercised without AWS.
 * `scanPageSize` forces the scan to page so the LastEvaluatedKey loop is covered.
 */
/**
 * The DAOs take a real `DynamoDBDocumentClient`, so these hand-written fakes are cast at the
 * injection point. The cast is deliberate and local: the fakes implement only the handful of
 * `send` overloads the DAO under test actually issues, which is what lets these tests assert
 * the exact command — `ConditionExpression` included — with no AWS SDK involved.
 */
function asDocClient(fake: { send: (command: never) => Promise<unknown> }): DynamoDBDocumentClient {
  return fake as unknown as DynamoDBDocumentClient;
}

class FakeDoc {
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

function record(overrides: Partial<GetApiKeyOutput> = {}): GetApiKeyOutput {
  return { keyId: 'k1', secretHash: 'hash1', name: 'one', createdAt: 100, ...overrides };
}

describe('DdbApiKeysDao', () => {
  it('creates a key and reads it back, omitting name when null', async () => {
    const doc = new FakeDoc();
    const dao = new DdbApiKeysDao(asDocClient(doc), 't');

    expect(await dao.createApiKey(record({ name: null }))).toEqual({ created: true });
    const stored = doc.store.get('k1') as PutCommandInput['Item'];
    expect(stored).not.toHaveProperty('name'); // null names are not persisted
    expect(await dao.getApiKey({ keyId: 'k1' })).toEqual(record({ name: null }));
  });

  it('refuses to overwrite an existing keyId (collision → false)', async () => {
    const doc = new FakeDoc();
    const dao = new DdbApiKeysDao(asDocClient(doc), 't');
    expect(await dao.createApiKey(record({ secretHash: 'first' }))).toEqual({ created: true });
    expect(await dao.createApiKey(record({ secretHash: 'second' }))).toEqual({ created: false });
    expect((await dao.getApiKey({ keyId: 'k1' }))?.secretHash).toBe('first');
  });

  it('returns null for an unknown key', async () => {
    const dao = new DdbApiKeysDao(asDocClient(new FakeDoc()), 't');
    expect(await dao.getApiKey({ keyId: 'missing' })).toBeNull();
  });

  it('lists every key across scan pages', async () => {
    const doc = new FakeDoc();
    doc.scanPageSize = 1; // force pagination
    const dao = new DdbApiKeysDao(asDocClient(doc), 't');
    await dao.createApiKey(record({ keyId: 'a', createdAt: 1 }));
    await dao.createApiKey(record({ keyId: 'b', createdAt: 2 }));
    await dao.createApiKey(record({ keyId: 'c', createdAt: 3 }));

    const ids = (await dao.listApiKeys({})).apiKeys.map((r) => r.keyId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('deletes a key and is a no-op on an unknown id', async () => {
    const doc = new FakeDoc();
    const dao = new DdbApiKeysDao(asDocClient(doc), 't');
    await dao.createApiKey(record());
    await dao.deleteApiKey({ keyId: 'k1' });
    expect(await dao.getApiKey({ keyId: 'k1' })).toBeNull();
    await expect(dao.deleteApiKey({ keyId: 'missing' })).resolves.toEqual({});
  });
});
