/**
 * Which forwarding rules a received message matches, and where it goes. Pure: the rule
 * semantics are documented on {@link ForwardingRule} (`@freemail/shared/forwarding.ts`).
 */
import type { ForwardingRule } from '@freemail/shared';

export interface ForwardingCandidate {
  /** The message's From address. */
  readonly from: string;
  /** The From domain SES's DMARC check passed for; absent → only a rule ignoring DMARC can match. */
  readonly authenticatedDomain: string | undefined;
  /** The message's To and Cc header addresses. */
  readonly recipients: readonly string[];
}

export interface ForwardingMatch {
  /** The matching rules' ids, in rule order. */
  readonly ruleIds: readonly string[];
  /** Every matching rule's targets, lowercased, each once, in rule order. */
  readonly forwardTo: readonly string[];
}

export function matchForwardingRules(rules: readonly ForwardingRule[], candidate: ForwardingCandidate): ForwardingMatch {
  const from = normalizeAddress(candidate.from);
  const fromDomain = domainOf(from);
  const message: NormalizedCandidate = {
    from,
    fromDomain,
    senderAuthenticated: fromDomain !== '' && candidate.authenticatedDomain?.toLowerCase() === fromDomain,
    recipients: candidate.recipients.map(normalizeAddress),
  };
  const ruleIds: string[] = [];
  const forwardTo = new Set<string>();
  for (const rule of rules) {
    if (!ruleMatches(rule, message)) {
      continue;
    }
    ruleIds.push(rule.id);
    for (const target of rule.forwardTo) {
      const address = normalizeAddress(target);
      if (address !== '') {
        forwardTo.add(address);
      }
    }
  }
  return { ruleIds, forwardTo: [...forwardTo] };
}

/** The lowercased domain of an address, or `''` when it has none. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) {
    return '';
  }
  const domain = address.slice(at + 1);
  return domain.trim().toLowerCase();
}

interface NormalizedCandidate {
  readonly from: string;
  readonly fromDomain: string;
  readonly senderAuthenticated: boolean;
  readonly recipients: readonly string[];
}

function ruleMatches(rule: ForwardingRule, message: NormalizedCandidate): boolean {
  if (!rule.enabled) {
    return false;
  }
  const senderDomains = valueSet(rule.senderDomains);
  const senderAddresses = valueSet(rule.senderAddresses);
  const recipientDomains = valueSet(rule.recipientDomains);
  const recipientAddresses = valueSet(rule.recipientAddresses);
  const hasSender = senderDomains.size > 0 || senderAddresses.size > 0;
  const hasRecipient = recipientDomains.size > 0 || recipientAddresses.size > 0;
  if (!hasSender && !hasRecipient) {
    return false;
  }
  if (!rule.ignoreDmarcVerification && !message.senderAuthenticated) {
    return false;
  }
  if (hasSender && !senderAddresses.has(message.from) && !senderDomains.has(message.fromDomain)) {
    return false;
  }
  if (hasRecipient && !message.recipients.some((recipient) => recipientAddresses.has(recipient) || recipientDomains.has(domainOf(recipient)))) {
    return false;
  }
  return true;
}

/** A rule's values, normalized, with blanks dropped (a blank must never match an address with no domain). */
function valueSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizeAddress).filter((value) => value !== ''));
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
