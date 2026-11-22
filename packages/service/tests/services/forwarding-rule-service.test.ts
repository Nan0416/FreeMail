import { MAX_FORWARDING_RULES, type ForwardingRule, type ForwardingRuleFields } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type { CreateForwardingRuleInput, ForwardingRulesDao, UpdateForwardingRuleInput } from '../../src/data/forwarding-rules-dao.js';
import { ForwardingRuleService } from '../../src/services/forwarding-rule-service.js';
import { EmailError } from '../../src/utils/errors.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');

const FIELDS: ForwardingRuleFields = {
  name: 'Amazon returns',
  enabled: true,
  senderDomains: ['returns.amazon.com'],
  senderAddresses: [],
  recipientDomains: [],
  recipientAddresses: [],
  forwardTo: ['trex@example.com', 'nan@example.com'],
  ignoreDmarcVerification: false,
};

/** An in-memory rules table with the DAO's conditions. */
class FakeRulesDao implements ForwardingRulesDao {
  readonly rules = new Map<string, ForwardingRule>();
  collisions = 0;

  listForwardingRules() {
    return Promise.resolve({ rules: [...this.rules.values()] });
  }

  createForwardingRule(input: CreateForwardingRuleInput) {
    if (this.collisions > 0 || this.rules.has(input.id)) {
      this.collisions -= 1;
      return Promise.resolve({ created: false });
    }
    this.rules.set(input.id, input);
    return Promise.resolve({ created: true });
  }

  updateForwardingRule(input: UpdateForwardingRuleInput) {
    const existing = this.rules.get(input.id);
    if (!existing) {
      return Promise.resolve(null);
    }
    const updated = { ...input, createdAt: existing.createdAt };
    this.rules.set(input.id, updated);
    return Promise.resolve(updated);
  }

  deleteForwardingRule(input: { id: string }) {
    this.rules.delete(input.id);
    return Promise.resolve({});
  }
}

function service(dao: FakeRulesDao, ids: string[] = ['id-1', 'id-2', 'id-3']) {
  let next = 0;
  return new ForwardingRuleService({
    forwardingRulesDao: dao,
    emailDomain: 'warehouse.example',
    now: () => NOW,
    newId: () => ids[next++] ?? `id-${next}`,
  });
}

async function rejection(promise: Promise<unknown>): Promise<EmailError> {
  const error = await promise.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(EmailError);
  return error as EmailError;
}

describe('ForwardingRuleService — create', () => {
  it('stores the normalized rule with a new id and timestamps, and returns it', async () => {
    const dao = new FakeRulesDao();

    const created = await service(dao).createForwardingRule({
      ...FIELDS,
      name: '  Amazon returns ',
      senderDomains: ['Returns.Amazon.com'],
    });

    expect(created).toEqual({
      ...FIELDS,
      id: 'id-1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect([...dao.rules.values()]).toEqual([created]);
  });

  it('rejects an invalid rule with the shared check’s message, storing nothing', async () => {
    const dao = new FakeRulesDao();

    const error = await rejection(service(dao).createForwardingRule({ ...FIELDS, forwardTo: [] }));

    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toBe('Add at least one address to forward to.');
    expect(dao.rules.size).toBe(0);
  });

  it('refuses a target on this deployment’s own domain (a loop)', async () => {
    const error = await rejection(
      service(new FakeRulesDao()).createForwardingRule({
        ...FIELDS,
        forwardTo: ['ops@Warehouse.Example'],
      }),
    );

    expect(error.message).toMatch(/would come straight back here/);
  });

  it('retries a colliding id', async () => {
    const dao = new FakeRulesDao();
    dao.collisions = 1;

    expect((await service(dao).createForwardingRule(FIELDS)).id).toBe('id-2');
  });

  it('caps the number of rules', async () => {
    const dao = new FakeRulesDao();
    for (let i = 0; i < MAX_FORWARDING_RULES; i += 1) {
      dao.rules.set(`r${i}`, { ...FIELDS, id: `r${i}`, createdAt: 'x', updatedAt: 'x' });
    }

    const error = await rejection(service(dao).createForwardingRule(FIELDS));

    expect(error.message).toBe('There can be at most 100 forwarding rules. Delete one first.');
  });
});

describe('ForwardingRuleService — list, update, delete', () => {
  it('lists oldest first (ties by id), whatever order the table returns', async () => {
    const dao = new FakeRulesDao();
    for (const [id, createdAt] of [
      ['c', '2026-11-13T03:00:00.000Z'],
      ['b', '2026-11-13T01:00:00.000Z'],
      ['a', '2026-11-13T03:00:00.000Z'],
    ] as const) {
      dao.rules.set(id, { ...FIELDS, id, createdAt, updatedAt: createdAt });
    }

    const listed = await service(dao).listForwardingRules({});

    expect(listed.rules.map((rule) => rule.id)).toEqual(['b', 'a', 'c']);
  });

  it('replaces a rule’s fields, normalized, keeping its id and createdAt', async () => {
    const dao = new FakeRulesDao();
    const rules = service(dao);
    const created = await rules.createForwardingRule(FIELDS);
    const later = new Date('2026-11-14T00:00:00.000Z');
    const updater = new ForwardingRuleService({
      forwardingRulesDao: dao,
      emailDomain: 'warehouse.example',
      now: () => later,
    });

    const updated = await updater.updateForwardingRule({
      ...FIELDS,
      id: created.id,
      enabled: false,
      forwardTo: ['Ops@Example.org'],
    });

    expect(updated).toEqual({
      ...FIELDS,
      enabled: false,
      forwardTo: ['ops@example.org'],
      id: created.id,
      createdAt: NOW.toISOString(),
      updatedAt: later.toISOString(),
    });
  });

  it('answers 404 for an unknown rule, creating nothing', async () => {
    const dao = new FakeRulesDao();

    const error = await rejection(service(dao).updateForwardingRule({ ...FIELDS, id: 'gone' }));

    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(dao.rules.size).toBe(0);
  });

  it('validates an update like a create', async () => {
    const dao = new FakeRulesDao();
    const created = await service(dao).createForwardingRule(FIELDS);

    const error = await rejection(service(dao).updateForwardingRule({ ...FIELDS, id: created.id, name: ' ' }));

    expect(error.message).toBe('Give the rule a name.');
    expect(dao.rules.get(created.id)?.name).toBe('Amazon returns');
  });

  it('deletes idempotently', async () => {
    const dao = new FakeRulesDao();
    const rules = service(dao);
    const created = await rules.createForwardingRule(FIELDS);

    await rules.deleteForwardingRule({ id: created.id });
    await rules.deleteForwardingRule({ id: created.id });

    expect(dao.rules.size).toBe(0);
  });
});
