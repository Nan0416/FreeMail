import type { ForwardingRule } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORWARDING_RULE_FORM, fieldsFromForm, fieldsOf, formFromRule, partitionEntries, splitEntries } from '../../src/lib/forwarding.js';

const RULE: ForwardingRule = {
  id: 'r1',
  name: 'Amazon returns',
  enabled: false,
  senderDomains: ['returns.amazon.com'],
  senderAddresses: ['ops@amazon.com'],
  recipientDomains: [],
  recipientAddresses: ['rma@warehouse.example'],
  forwardTo: ['trex@example.com', 'nan@example.com'],
  ignoreDmarcVerification: true,
  createdAt: 't0',
  updatedAt: 't1',
};

describe('splitEntries', () => {
  it('splits on newlines, commas, semicolons and spaces, dropping blanks', () => {
    expect(splitEntries(' a.com,b.com;\n\n c@d.com  e.com\t')).toEqual(['a.com', 'b.com', 'c@d.com', 'e.com']);
    expect(splitEntries('   ')).toEqual([]);
  });
});

describe('partitionEntries', () => {
  it('reads an entry with an @ after its first character as an address, anything else as a domain', () => {
    expect(partitionEntries(['a.com', 'x@b.com', '@c.com', 'not-a-domain'])).toEqual({
      domains: ['a.com', '@c.com', 'not-a-domain'],
      addresses: ['x@b.com'],
    });
  });
});

describe('the form ↔ the rule', () => {
  it('turns a form into a rule’s fields', () => {
    expect(
      fieldsFromForm({
        name: 'Returns',
        senders: 'returns.amazon.com\nops@amazon.com',
        recipients: 'rma@warehouse.example, warehouse.example',
        forwardTo: 'trex@example.com\nnan@example.com',
        enabled: true,
        ignoreDmarcVerification: false,
      }),
    ).toEqual({
      name: 'Returns',
      enabled: true,
      senderDomains: ['returns.amazon.com'],
      senderAddresses: ['ops@amazon.com'],
      recipientDomains: ['warehouse.example'],
      recipientAddresses: ['rma@warehouse.example'],
      forwardTo: ['trex@example.com', 'nan@example.com'],
      ignoreDmarcVerification: false,
    });
  });

  it('round-trips a stored rule through the form', () => {
    expect(fieldsFromForm(formFromRule(RULE))).toEqual(fieldsOf(RULE));
  });

  it('starts a new rule enabled and DMARC-checked', () => {
    expect(EMPTY_FORWARDING_RULE_FORM.enabled).toBe(true);
    expect(EMPTY_FORWARDING_RULE_FORM.ignoreDmarcVerification).toBe(false);
  });

  it('keeps only the editable fields', () => {
    expect(Object.keys(fieldsOf(RULE)).sort()).toEqual(
      ['enabled', 'forwardTo', 'ignoreDmarcVerification', 'name', 'recipientAddresses', 'recipientDomains', 'senderAddresses', 'senderDomains'].sort(),
    );
  });
});
