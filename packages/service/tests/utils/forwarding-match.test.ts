import { describe, expect, it } from 'vitest';
import type { ForwardingRule } from '@freemail/shared';
import { domainOf, matchForwardingRules } from '../../src/utils/forwarding-match.js';

const AUTHENTICATED = {
  from: 'Alice@Customer.com',
  authenticatedDomain: 'customer.com',
  recipients: ['billing@corp.example'],
};

function rule(overrides: Partial<ForwardingRule>): ForwardingRule {
  return {
    id: 'r1',
    name: 'Rule',
    enabled: true,
    senderDomains: [],
    senderAddresses: [],
    recipientDomains: [],
    recipientAddresses: [],
    forwardTo: ['ops@example.org'],
    ignoreDmarcVerification: false,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('matchForwardingRules — sender conditions', () => {
  it('matches the From domain, case-insensitively, when DMARC passed for it', () => {
    const match = matchForwardingRules([rule({ senderDomains: ['CUSTOMER.com'] })], AUTHENTICATED);

    expect(match).toEqual({ ruleIds: ['r1'], forwardTo: ['ops@example.org'] });
  });

  it('matches a listed From address', () => {
    const match = matchForwardingRules([rule({ senderAddresses: ['alice@customer.com'] })], AUTHENTICATED);

    expect(match.ruleIds).toEqual(['r1']);
  });

  it('never matches an unauthenticated sender — From is just a header anyone can write', () => {
    const rules = [rule({ senderDomains: ['customer.com'] })];

    expect(matchForwardingRules(rules, { ...AUTHENTICATED, authenticatedDomain: undefined }).ruleIds).toEqual([]);
    // DMARC passed, but for a different domain than the From's.
    expect(matchForwardingRules(rules, { ...AUTHENTICATED, authenticatedDomain: 'attacker.com' }).ruleIds).toEqual([]);
  });

  it('matches domains exactly, not their subdomains or parents', () => {
    const rules = [rule({ senderDomains: ['customer.com'] })];

    expect(
      matchForwardingRules(rules, {
        ...AUTHENTICATED,
        from: 'a@mail.customer.com',
        authenticatedDomain: 'mail.customer.com',
      }).ruleIds,
    ).toEqual([]);
  });
});

describe('matchForwardingRules — recipient conditions', () => {
  it('matches any To/Cc address on a listed domain, case-insensitively', () => {
    const match = matchForwardingRules([rule({ recipientDomains: ['billing.example.com'] })], {
      ...AUTHENTICATED,
      recipients: ['billing@corp.example', 'R123@Billing.Example.com'],
    });

    expect(match.ruleIds).toEqual(['r1']);
  });

  it('still needs an authenticated sender, though no condition is on the sender', () => {
    const rules = [rule({ recipientDomains: ['billing.example.com'] })];
    const cc = { recipients: ['x@billing.example.com'] };

    expect(matchForwardingRules(rules, { ...AUTHENTICATED, ...cc, authenticatedDomain: undefined }).ruleIds).toEqual([]);
    expect(matchForwardingRules(rules, { ...AUTHENTICATED, ...cc }).ruleIds).toEqual(['r1']);
  });

  it('matches a listed recipient address', () => {
    const match = matchForwardingRules([rule({ recipientAddresses: ['billing@corp.example'] })], AUTHENTICATED);

    expect(match.ruleIds).toEqual(['r1']);
  });

  it('does not match when no recipient is listed', () => {
    const match = matchForwardingRules([rule({ recipientDomains: ['billing.example.com'] })], AUTHENTICATED);

    expect(match.ruleIds).toEqual([]);
  });
});

describe('matchForwardingRules — ignoreDmarcVerification', () => {
  const SPOOFED = { ...AUTHENTICATED, authenticatedDomain: undefined };

  it('lets a recipient rule match a sender that failed DMARC or has none', () => {
    const match = matchForwardingRules([rule({ recipientAddresses: ['billing@corp.example'], ignoreDmarcVerification: true })], SPOOFED);

    expect(match.ruleIds).toEqual(['r1']);
  });

  it('lets a sender rule match an unverified From — which anyone can forge', () => {
    const match = matchForwardingRules([rule({ senderDomains: ['customer.com'], ignoreDmarcVerification: true })], SPOOFED);

    expect(match.ruleIds).toEqual(['r1']);
  });

  it('is off unless exactly true, and only for the rule that sets it', () => {
    const match = matchForwardingRules(
      [
        rule({ id: 'off', senderDomains: ['customer.com'], ignoreDmarcVerification: false }),
        rule({ id: 'absent', senderDomains: ['customer.com'] }),
        rule({ id: 'on', senderDomains: ['customer.com'], ignoreDmarcVerification: true }),
      ],
      SPOOFED,
    );

    expect(match.ruleIds).toEqual(['on']);
  });

  it('still needs the rule’s conditions to match', () => {
    const rules = [rule({ ignoreDmarcVerification: true }), rule({ id: 'r2', senderDomains: ['other.com'], ignoreDmarcVerification: true })];

    expect(matchForwardingRules(rules, SPOOFED).ruleIds).toEqual([]);
  });
});

describe('matchForwardingRules — enabled', () => {
  it('never matches a disabled rule, however well it fits', () => {
    const rules = [rule({ id: 'off', enabled: false, senderDomains: ['customer.com'] }), rule({ id: 'on', senderDomains: ['customer.com'] })];

    expect(matchForwardingRules(rules, AUTHENTICATED).ruleIds).toEqual(['on']);
  });

  it('never matches a disabled rule that ignores DMARC either', () => {
    const match = matchForwardingRules([rule({ enabled: false, senderDomains: ['customer.com'], ignoreDmarcVerification: true })], { ...AUTHENTICATED, authenticatedDomain: undefined });

    expect(match.ruleIds).toEqual([]);
  });
});

describe('matchForwardingRules — combining', () => {
  it('needs both kinds to match when a rule has both (AND)', () => {
    const rules = [rule({ senderDomains: ['customer.com'], recipientDomains: ['billing.example.com'] })];

    expect(matchForwardingRules(rules, AUTHENTICATED).ruleIds).toEqual([]);
    expect(
      matchForwardingRules(rules, {
        ...AUTHENTICATED,
        recipients: ['x@billing.example.com'],
      }).ruleIds,
    ).toEqual(['r1']);
  });

  it('matches nothing for a rule with no conditions (never forwards everything)', () => {
    expect(matchForwardingRules([rule({})], AUTHENTICATED).ruleIds).toEqual([]);
    expect(
      matchForwardingRules([rule({ senderDomains: [' '], recipientDomains: [''] })], {
        ...AUTHENTICATED,
        recipients: ['no-domain'],
      }).ruleIds,
    ).toEqual([]);
  });

  it('sends to every matching rule’s targets, lowercased and each once', () => {
    const match = matchForwardingRules(
      [
        rule({ id: 'a', senderDomains: ['customer.com'], forwardTo: ['Ops@Example.org'] }),
        rule({ id: 'b', recipientDomains: ['other.com'], forwardTo: ['never@example.org'] }),
        rule({
          id: 'c',
          recipientAddresses: ['billing@corp.example'],
          forwardTo: ['ops@example.org', 'bob@example.org'],
        }),
      ],
      AUTHENTICATED,
    );

    expect(match).toEqual({
      ruleIds: ['a', 'c'],
      forwardTo: ['ops@example.org', 'bob@example.org'],
    });
  });
});

describe('domainOf', () => {
  it('takes the part after the last @, lowercased; none → empty', () => {
    expect(domainOf('A@B.Example')).toBe('b.example');
    expect(domainOf('"a@b"@c.example')).toBe('c.example');
    expect(domainOf('no-domain')).toBe('');
  });
});
