import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ForwardingRule } from '@freemail/shared';
import { describe, expect, it, vi } from 'vitest';
import { DdbForwardingRulesDao } from '../../src/data/ddb-forwarding-rules-dao.js';

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/** The DAO takes a real document client; the fake implements only the commands it issues. */
function asDocClient(fake: { send: (command: never) => Promise<unknown> }): DynamoDBDocumentClient {
  return fake as unknown as DynamoDBDocumentClient;
}

/**
 * In-memory table honoring the create and update conditions, a paginated scan, and an update's
 * `SET` of `#field = :field` pairs, so the DAO's guards are exercised without AWS.
 */
class FakeDoc {
  readonly store = new Map<string, Record<string, unknown>>();
  readonly commands: unknown[] = [];
  scanPageSize = 100;

  send(command: PutCommand | UpdateCommand | DeleteCommand | ScanCommand): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof PutCommand) {
      const item = command.input.Item as Record<string, unknown>;
      if (command.input.ConditionExpression === 'attribute_not_exists(id)' && this.store.has(String(item.id))) {
        return Promise.reject(conditionalCheckFailed());
      }
      this.store.set(String(item.id), item);
      return Promise.resolve({});
    }
    if (command instanceof UpdateCommand) {
      const id = String(command.input.Key?.id);
      const existing = this.store.get(id);
      if (command.input.ConditionExpression === 'attribute_exists(id)' && !existing) {
        return Promise.reject(conditionalCheckFailed());
      }
      const updated: Record<string, unknown> = { ...(existing ?? { id }) };
      const names = command.input.ExpressionAttributeNames ?? {};
      const values = command.input.ExpressionAttributeValues ?? {};
      for (const assignment of (command.input.UpdateExpression ?? '').replace(/^SET /, '').split(', ')) {
        const [name, value] = assignment.split(' = ') as [string, string];
        updated[names[name] as string] = values[value];
      }
      this.store.set(id, updated);
      return Promise.resolve({ Attributes: updated });
    }
    if (command instanceof DeleteCommand) {
      this.store.delete(String(command.input.Key?.id));
      return Promise.resolve({});
    }
    if (command instanceof ScanCommand) {
      const all = [...this.store.values()];
      const start = command.input.ExclusiveStartKey ? all.findIndex((item) => item.id === command.input.ExclusiveStartKey?.id) + 1 : 0;
      const page = all.slice(start, start + this.scanPageSize);
      const last = page[page.length - 1];
      const more = start + this.scanPageSize < all.length;
      return Promise.resolve({
        Items: page,
        ...(more && last ? { LastEvaluatedKey: { id: last.id } } : {}),
      });
    }
    return Promise.reject(new Error('unsupported command'));
  }
}

function rule(overrides: Partial<ForwardingRule> = {}): ForwardingRule {
  return {
    id: 'r1',
    name: 'Amazon returns',
    enabled: true,
    senderDomains: ['returns.amazon.com'],
    senderAddresses: [],
    recipientDomains: [],
    recipientAddresses: [],
    forwardTo: ['trex@example.com', 'nan@example.com'],
    ignoreDmarcVerification: false,
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('DdbForwardingRulesDao', () => {
  it('creates a rule and lists it back exactly', async () => {
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');

    expect(await dao.createForwardingRule(rule())).toEqual({ created: true });
    expect(await dao.listForwardingRules({})).toEqual({ rules: [rule()] });
    expect((doc.commands[0] as PutCommand).input.TableName).toBe('rules');
  });

  it('refuses to overwrite an existing id (collision → false)', async () => {
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    await dao.createForwardingRule(rule({ name: 'first' }));

    expect(await dao.createForwardingRule(rule({ name: 'second' }))).toEqual({ created: false });
    expect((await dao.listForwardingRules({})).rules.map((r) => r.name)).toEqual(['first']);
  });

  it('lists every rule across scan pages', async () => {
    const doc = new FakeDoc();
    doc.scanPageSize = 1;
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    for (const id of ['a', 'b', 'c']) {
      await dao.createForwardingRule(rule({ id }));
    }

    expect((await dao.listForwardingRules({})).rules.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips a malformed row rather than failing every other rule', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    await dao.createForwardingRule(rule({ id: 'good' }));
    doc.store.set('bad', { ...rule({ id: 'bad' }), forwardTo: 'not-a-list' });
    doc.store.set('worse', { id: 'worse' });

    expect((await dao.listForwardingRules({})).rules.map((r) => r.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('replaces every editable field on update, keeping createdAt', async () => {
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    await dao.createForwardingRule(rule());
    const edited = {
      id: 'r1',
      name: 'Renamed',
      enabled: false,
      senderDomains: [],
      senderAddresses: ['a@b.com'],
      recipientDomains: ['c.com'],
      recipientAddresses: ['d@e.com'],
      forwardTo: ['f@g.com'],
      ignoreDmarcVerification: true,
      updatedAt: '2026-11-14T00:00:00.000Z',
    };

    const updated = await dao.updateForwardingRule(edited);

    expect(updated).toEqual({ ...edited, createdAt: '2026-11-13T10:00:00.000Z' });
    expect((await dao.listForwardingRules({})).rules).toEqual([updated]);
    const command = doc.commands.find((sent) => sent instanceof UpdateCommand) as UpdateCommand;
    expect(command.input.ConditionExpression).toBe('attribute_exists(id)');
    expect(command.input.ReturnValues).toBe('ALL_NEW');
  });

  it('returns null for an update to an unknown id, creating nothing', async () => {
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    const edited = { ...rule({ id: 'gone' }) } as Partial<ForwardingRule>;
    delete edited.createdAt;

    expect(await dao.updateForwardingRule(edited as Omit<ForwardingRule, 'createdAt'>)).toBeNull();
    expect(doc.store.size).toBe(0);
  });

  it('deletes a rule, and is a no-op for an unknown id', async () => {
    const doc = new FakeDoc();
    const dao = new DdbForwardingRulesDao(asDocClient(doc), 'rules');
    await dao.createForwardingRule(rule());

    expect(await dao.deleteForwardingRule({ id: 'r1' })).toEqual({});
    expect((await dao.listForwardingRules({})).rules).toEqual([]);
    await expect(dao.deleteForwardingRule({ id: 'missing' })).resolves.toEqual({});
  });

  it('lets an unexpected DynamoDB error propagate', async () => {
    const dao = new DdbForwardingRulesDao(asDocClient({ send: () => Promise.reject(new Error('throttled')) }), 'rules');

    await expect(dao.createForwardingRule(rule())).rejects.toThrow('throttled');
    await expect(dao.updateForwardingRule(rule())).rejects.toThrow('throttled');
  });
});
