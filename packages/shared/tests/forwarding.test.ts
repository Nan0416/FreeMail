import { describe, expect, it } from 'vitest';
import { MAX_FORWARDING_RULE_NAME_LENGTH, MAX_FORWARDING_RULE_VALUES, checkForwardingRule, isForwardingDomain, type ForwardingRuleFields } from '../src/forwarding.js';

const FIELDS: ForwardingRuleFields = {
  name: 'Vendor invoices',
  enabled: true,
  senderDomains: ['billing.example.com'],
  senderAddresses: [],
  recipientDomains: [],
  recipientAddresses: [],
  forwardTo: ['alex@example.com'],
  ignoreDmarcVerification: false,
};

function errorOf(fields: Partial<ForwardingRuleFields>, ownDomain?: string): string | undefined {
  const check = checkForwardingRule({ ...FIELDS, ...fields }, ownDomain);
  return check.ok ? undefined : check.error;
}

describe('checkForwardingRule', () => {
  it('accepts a valid rule unchanged', () => {
    expect(checkForwardingRule(FIELDS)).toEqual({ ok: true, fields: FIELDS });
  });

  it('normalizes: trims the name; lowercases, de-duplicates and drops blank values', () => {
    const check = checkForwardingRule({
      ...FIELDS,
      name: '  Invoices  ',
      senderDomains: [' Billing.Example.COM ', '@billing.example.com', 'example.com.', ''],
      senderAddresses: ['Alice@Customer.com', 'alice@customer.com'],
      recipientDomains: ['  '],
      recipientAddresses: [],
      forwardTo: ['alex@example.com', 'sam@example.com', 'alex@example.com'],
    });

    expect(check).toEqual({
      ok: true,
      fields: {
        ...FIELDS,
        name: 'Invoices',
        senderDomains: ['billing.example.com', 'example.com'],
        senderAddresses: ['alice@customer.com'],
        recipientDomains: [],
        recipientAddresses: [],
        forwardTo: ['alex@example.com', 'sam@example.com'],
      },
    });
  });

  it('keeps the flags as given', () => {
    const check = checkForwardingRule({ ...FIELDS, enabled: false, ignoreDmarcVerification: true });

    expect(check.ok && check.fields.enabled).toBe(false);
    expect(check.ok && check.fields.ignoreDmarcVerification).toBe(true);
  });

  it('needs a name, at most the maximum length', () => {
    expect(errorOf({ name: '   ' })).toBe('Give the rule a name.');
    expect(errorOf({ name: 'x'.repeat(MAX_FORWARDING_RULE_NAME_LENGTH) })).toBeUndefined();
    expect(errorOf({ name: 'x'.repeat(MAX_FORWARDING_RULE_NAME_LENGTH + 1) })).toMatch(/at most 100 characters/);
  });

  it('needs at least one condition and at least one target', () => {
    expect(errorOf({ senderDomains: [' '] })).toBe('Add at least one sender or recipient to match.');
    expect(errorOf({ forwardTo: [] })).toBe('Add at least one address to forward to.');
  });

  it('names the first invalid value and its kind', () => {
    expect(errorOf({ senderDomains: ['not a domain'] })).toBe('"not a domain" isn\'t a valid sender domain.');
    expect(errorOf({ recipientDomains: ['localhost'] })).toBe('"localhost" isn\'t a valid recipient domain.');
    expect(errorOf({ senderAddresses: ['alice'] })).toBe('"alice" isn\'t a valid sender address.');
    expect(errorOf({ recipientAddresses: ['a@b@c.com'] })).toBe('"a@b@c.com" isn\'t a valid recipient address.');
    expect(errorOf({ forwardTo: ['ops@-bad-.com'] })).toBe('"ops@-bad-.com" isn\'t a valid forwarding address.');
  });

  it('caps each list', () => {
    const many = Array.from({ length: MAX_FORWARDING_RULE_VALUES + 1 }, (_, i) => `d${i}.com`);

    expect(errorOf({ senderDomains: many.slice(1) })).toBeUndefined();
    expect(errorOf({ senderDomains: many })).toBe('A rule can list at most 50 of each kind of value.');
  });

  it('refuses a target on the deployment’s own domain, when given', () => {
    const fields = { forwardTo: ['ops@example.org', 'Loop@Corp.Example'] };

    expect(errorOf(fields)).toBeUndefined();
    expect(errorOf(fields, 'Corp.example')).toBe("Can't forward to loop@corp.example: mail to corp.example would come straight back here.");
    // A subdomain is somewhere else.
    expect(errorOf({ forwardTo: ['a@sub.corp.example'] }, 'corp.example')).toBeUndefined();
  });
});

describe('isForwardingDomain', () => {
  it('takes dotted DNS names only', () => {
    for (const domain of ['example.com', 'billing.example.com', 'xn--bcher-kva.example', 'a-b.co']) {
      expect(isForwardingDomain(domain), domain).toBe(true);
    }
    for (const domain of ['', 'com', '-a.com', 'a-.com', 'a..com', 'a b.com', 'a_b.com', '.com']) {
      expect(isForwardingDomain(domain), domain).toBe(false);
    }
  });
});
