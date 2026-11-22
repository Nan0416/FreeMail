/**
 * Wire contract for forwarding rules, shared by the service (which stores and applies them) and
 * the web app (which edits them).
 *
 * A rule re-sends received mail that matches it to outside addresses. How a rule matches:
 * - **The sender is always checked first.** A rule matches only mail that passed SES's DMARC
 *   check for its From domain, whatever its conditions: `From` is otherwise just a header anyone
 *   can write, and the forwarded copy drops the original's authentication headers, so its
 *   recipient can't check the sender — the forwarder must. `ignoreDmarcVerification` turns the
 *   check off for one rule; its sender conditions then match a From anyone can forge.
 * - **Sender** (`senderDomains` / `senderAddresses`): the message's `From`.
 * - **Recipient** (`recipientDomains` / `recipientAddresses`): any `To` or `Cc` header address.
 *   These are the addresses the message was written to, not the SMTP envelope — the envelope
 *   recipient is always one of this deployment's own addresses, and Bcc'd mail lists none.
 * - Within one kind, any listed value matches (OR). A rule with both kinds needs both (AND). A
 *   rule with no conditions matches nothing, so a half-written rule can never forward every
 *   message. Domains match exactly, case-insensitively: `example.com` does not match
 *   `mail.example.com`.
 * - A disabled rule matches nothing.
 *
 * A message that matches several rules is sent once, to all their addresses together.
 */
import { normalizeDomain } from './domain.js';
import { isValidEmailAddress } from './email.js';

/** Upper bound on stored rules. A single-tenant deployment needs a handful. */
export const MAX_FORWARDING_RULES = 100;
/** Upper bound on a rule's name, after trimming. */
export const MAX_FORWARDING_RULE_NAME_LENGTH = 100;
/** Upper bound on each of a rule's lists: each condition list, and its targets. */
export const MAX_FORWARDING_RULE_VALUES = 50;

/** What a person edits: everything about a rule except its id and timestamps. */
export interface ForwardingRuleFields {
  /** A label to tell rules apart. */
  readonly name: string;
  /** A disabled rule is kept but matches nothing. */
  readonly enabled: boolean;
  readonly senderDomains: readonly string[];
  readonly senderAddresses: readonly string[];
  readonly recipientDomains: readonly string[];
  readonly recipientAddresses: readonly string[];
  /** Where matching mail goes. Never an address on this deployment's own domain (a loop). */
  readonly forwardTo: readonly string[];
  /**
   * Match without SES's DMARC pass for the From domain: for a sender whose domain publishes no
   * DMARC record, or whose mail fails it on the way (some forwarders and mailing lists). On, the
   * rule's sender conditions match a From anyone can forge.
   */
  readonly ignoreDmarcVerification: boolean;
}

/** A stored rule. */
export interface ForwardingRule extends ForwardingRuleFields {
  /** Stable id — logged and recorded on each forward, so a forward can be traced to its rule. */
  readonly id: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** ISO-8601 UTC. */
  readonly updatedAt: string;
}

export type CreateForwardingRuleRequest = ForwardingRuleFields;

export type UpdateForwardingRuleRequest = ForwardingRuleFields;

export interface ListForwardingRulesResponse {
  /** Oldest first. */
  readonly rules: readonly ForwardingRule[];
}

/** {@link checkForwardingRule}'s verdict: the normalized fields, or the first problem found. */
export type ForwardingRuleCheck = { readonly ok: true; readonly fields: ForwardingRuleFields } | { readonly ok: false; readonly error: string };

/**
 * Validate and normalize a rule's fields: trim the name; lowercase, de-duplicate and drop blank
 * values; strip a leading `@` from a domain. The service enforces exactly this, and the web app
 * pre-checks with it, so the two never disagree. `ownDomain` (the deployment's email domain,
 * when known) refuses targets on it: forwarding there would loop back in.
 */
export function checkForwardingRule(fields: ForwardingRuleFields, ownDomain?: string): ForwardingRuleCheck {
  const name = fields.name.trim();
  if (name.length === 0) {
    return fail('Give the rule a name.');
  }
  if (name.length > MAX_FORWARDING_RULE_NAME_LENGTH) {
    return fail(`The name must be at most ${MAX_FORWARDING_RULE_NAME_LENGTH} characters.`);
  }
  // Each list is a value list, or the error naming its first invalid value.
  const senderDomains = domainList(fields.senderDomains, 'sender domain');
  if (typeof senderDomains === 'string') {
    return fail(senderDomains);
  }
  const senderAddresses = addressList(fields.senderAddresses, 'sender address');
  if (typeof senderAddresses === 'string') {
    return fail(senderAddresses);
  }
  const recipientDomains = domainList(fields.recipientDomains, 'recipient domain');
  if (typeof recipientDomains === 'string') {
    return fail(recipientDomains);
  }
  const recipientAddresses = addressList(fields.recipientAddresses, 'recipient address');
  if (typeof recipientAddresses === 'string') {
    return fail(recipientAddresses);
  }
  const forwardTo = addressList(fields.forwardTo, 'forwarding address');
  if (typeof forwardTo === 'string') {
    return fail(forwardTo);
  }
  const conditions = senderDomains.length + senderAddresses.length + recipientDomains.length + recipientAddresses.length;
  if (conditions === 0) {
    return fail('Add at least one sender or recipient to match.');
  }
  if (forwardTo.length === 0) {
    return fail('Add at least one address to forward to.');
  }
  if (ownDomain !== undefined) {
    const own = normalizeDomain(ownDomain);
    const looping = forwardTo.find((address) => domainOfAddress(address) === own);
    if (looping !== undefined) {
      return fail(`Can't forward to ${looping}: mail to ${own} would come straight back here.`);
    }
  }
  return {
    ok: true,
    fields: {
      name,
      enabled: fields.enabled,
      senderDomains,
      senderAddresses,
      recipientDomains,
      recipientAddresses,
      forwardTo,
      ignoreDmarcVerification: fields.ignoreDmarcVerification,
    },
  };
}

/** A DNS name with at least two labels: letters, digits and inner hyphens, at most 253 chars. */
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether `value` (already normalized) is a domain a rule can name. */
export function isForwardingDomain(value: string): boolean {
  return DOMAIN_RE.test(value);
}

function domainList(values: readonly string[], label: string): readonly string[] | string {
  return normalizedList(
    values.map((value) => normalizeDomain(value).replace(/^@/, '')),
    label,
    isForwardingDomain,
  );
}

function addressList(values: readonly string[], label: string): readonly string[] | string {
  return normalizedList(
    values.map((value) => value.trim().toLowerCase()),
    label,
    (value) => isValidEmailAddress(value) && isForwardingDomain(domainOfAddress(value)),
  );
}

/** The non-blank values, each once, in order — or an error naming the first invalid one. */
function normalizedList(values: readonly string[], label: string, valid: (value: string) => boolean): readonly string[] | string {
  const unique = [...new Set(values.filter((value) => value !== ''))];
  const invalid = unique.find((value) => !valid(value));
  if (invalid !== undefined) {
    return `"${invalid}" isn't a valid ${label}.`;
  }
  if (unique.length > MAX_FORWARDING_RULE_VALUES) {
    return `A rule can list at most ${MAX_FORWARDING_RULE_VALUES} of each kind of value.`;
  }
  return unique;
}

function domainOfAddress(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

function fail(error: string): ForwardingRuleCheck {
  return { ok: false, error };
}
