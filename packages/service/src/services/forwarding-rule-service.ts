/**
 * Forwarding-rule management behind the `/forwarding-rules` routes: list, create, update,
 * delete. Every write is validated and normalized by the shared `checkForwardingRule` — the
 * same check the web app pre-runs, so the two never disagree — with this deployment's email
 * domain, so a rule can never forward back into it.
 *
 * The forwarder reads the same table (`ForwardingProcessor`), so a saved rule applies to the
 * next received message.
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_FORWARDING_RULES,
  checkForwardingRule,
  type CreateForwardingRuleRequest,
  type ForwardingRule,
  type ForwardingRuleFields,
  type ListForwardingRulesResponse,
  type UpdateForwardingRuleRequest,
} from '@freemail/shared';
import type { ForwardingRulesDao } from '../data/forwarding-rules-dao.js';
import { emailErrors } from '../utils/errors.js';

/** Random ids practically never collide; retry a few times rather than trust one draw. */
const MAX_CREATE_ATTEMPTS = 3;

export interface ForwardingRuleServiceDeps {
  readonly forwardingRulesDao: ForwardingRulesDao;
  /** This deployment's email domain: never a forward target. */
  readonly emailDomain: string;
  /** Injectable for tests. */
  readonly now?: () => Date;
  /** Injectable for tests. */
  readonly newId?: () => string;
}

/** No inputs: a single-tenant deployment lists all its (few) rules. */
export type ListForwardingRulesServiceRequest = Record<string, never>;

export type CreateForwardingRuleServiceRequest = CreateForwardingRuleRequest;

export interface UpdateForwardingRuleServiceRequest extends UpdateForwardingRuleRequest {
  readonly id: string;
}

export interface DeleteForwardingRuleServiceRequest {
  readonly id: string;
}

export class ForwardingRuleService {
  private readonly dao: ForwardingRulesDao;
  private readonly emailDomain: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: ForwardingRuleServiceDeps) {
    this.dao = deps.forwardingRulesDao;
    this.emailDomain = deps.emailDomain;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Every rule, oldest first, so the list doesn't reshuffle as rules are edited. */
  async listForwardingRules(_request: ListForwardingRulesServiceRequest): Promise<ListForwardingRulesResponse> {
    const result = await this.dao.listForwardingRules({});
    return { rules: [...result.rules].sort(byCreation) };
  }

  async createForwardingRule(request: CreateForwardingRuleServiceRequest): Promise<ForwardingRule> {
    const fields = this.checked(request);
    const existing = await this.dao.listForwardingRules({});
    if (existing.rules.length >= MAX_FORWARDING_RULES) {
      throw emailErrors.invalidRequest(`There can be at most ${MAX_FORWARDING_RULES} forwarding rules. Delete one first.`);
    }
    const at = this.now().toISOString();
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const rule: ForwardingRule = { ...fields, id: this.newId(), createdAt: at, updatedAt: at };
      const result = await this.dao.createForwardingRule(rule);
      if (result.created) {
        return rule;
      }
    }
    throw new Error('Failed to allocate a unique forwarding rule id.');
  }

  /** Replace a rule's fields. A rule deleted meanwhile is a 404, never recreated. */
  async updateForwardingRule(request: UpdateForwardingRuleServiceRequest): Promise<ForwardingRule> {
    const fields = this.checked(request);
    const updated = await this.dao.updateForwardingRule({
      ...fields,
      id: request.id,
      updatedAt: this.now().toISOString(),
    });
    if (updated === null) {
      throw emailErrors.notFound('No forwarding rule has that id.');
    }
    return updated;
  }

  /** Idempotent: deleting an unknown or already-deleted rule succeeds. */
  async deleteForwardingRule(request: DeleteForwardingRuleServiceRequest): Promise<void> {
    await this.dao.deleteForwardingRule({ id: request.id });
  }

  private checked(fields: ForwardingRuleFields): ForwardingRuleFields {
    const check = checkForwardingRule(fields, this.emailDomain);
    if (!check.ok) {
      throw emailErrors.invalidRequest(check.error);
    }
    return check.fields;
  }
}

function byCreation(a: ForwardingRule, b: ForwardingRule): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
