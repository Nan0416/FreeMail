/**
 * Pure helpers behind the forwarding rules page: the editor's text boxes ↔ a rule's lists. The
 * editor takes domains and addresses together in one box per side (an entry with an `@` after
 * its first character is an address, anything else a domain), and the rule keeps them apart.
 */
import type { ForwardingRule, ForwardingRuleFields } from '@freemail/shared';

/** The editor's state: one text box per side, plus the targets and flags. */
export interface ForwardingRuleForm {
  readonly name: string;
  /** Sender domains and addresses, separated by newlines, commas, semicolons or spaces. */
  readonly senders: string;
  /** Recipient (To/Cc) domains and addresses, likewise. */
  readonly recipients: string;
  /** Target addresses, likewise. */
  readonly forwardTo: string;
  readonly enabled: boolean;
  readonly ignoreDmarcVerification: boolean;
}

export const EMPTY_FORWARDING_RULE_FORM: ForwardingRuleForm = {
  name: '',
  senders: '',
  recipients: '',
  forwardTo: '',
  enabled: true,
  ignoreDmarcVerification: false,
};

/** The non-blank entries of a text box. */
export function splitEntries(text: string): string[] {
  return text.split(/[\s,;]+/).filter((entry) => entry !== '');
}

/** Entries split into domains and addresses. `@example.com` is a domain. */
export function partitionEntries(entries: readonly string[]): {
  readonly domains: string[];
  readonly addresses: string[];
} {
  const domains: string[] = [];
  const addresses: string[] = [];
  for (const entry of entries) {
    if (entry.indexOf('@') > 0) {
      addresses.push(entry);
    } else {
      domains.push(entry);
    }
  }
  return { domains, addresses };
}

/** The rule the form describes, before validation. */
export function fieldsFromForm(form: ForwardingRuleForm): ForwardingRuleFields {
  const senders = partitionEntries(splitEntries(form.senders));
  const recipients = partitionEntries(splitEntries(form.recipients));
  return {
    name: form.name,
    enabled: form.enabled,
    senderDomains: senders.domains,
    senderAddresses: senders.addresses,
    recipientDomains: recipients.domains,
    recipientAddresses: recipients.addresses,
    forwardTo: splitEntries(form.forwardTo),
    ignoreDmarcVerification: form.ignoreDmarcVerification,
  };
}

/** A stored rule as the editor shows it: one entry per line. */
export function formFromRule(rule: ForwardingRule): ForwardingRuleForm {
  return {
    name: rule.name,
    senders: [...rule.senderDomains, ...rule.senderAddresses].join('\n'),
    recipients: [...rule.recipientDomains, ...rule.recipientAddresses].join('\n'),
    forwardTo: rule.forwardTo.join('\n'),
    enabled: rule.enabled,
    ignoreDmarcVerification: rule.ignoreDmarcVerification,
  };
}

/** A rule's editable fields, for an update that changes only some of them. */
export function fieldsOf(rule: ForwardingRule): ForwardingRuleFields {
  return {
    name: rule.name,
    enabled: rule.enabled,
    senderDomains: rule.senderDomains,
    senderAddresses: rule.senderAddresses,
    recipientDomains: rule.recipientDomains,
    recipientAddresses: rule.recipientAddresses,
    forwardTo: rule.forwardTo,
    ignoreDmarcVerification: rule.ignoreDmarcVerification,
  };
}
