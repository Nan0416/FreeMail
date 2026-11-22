/**
 * Persistence port for forwarding rules: which received mail is re-sent to which outside
 * addresses. An interface so the forwarding processor and the rules service are testable with
 * any rule set. The DynamoDB implementation lives in `ddb-forwarding-rules-dao.ts`.
 *
 * A row is exactly the wire {@link ForwardingRule} (`@freemail/shared/forwarding.ts`, where the
 * matching semantics are documented). Validation is the rules service's job: the DAO stores
 * what it is given.
 */
import type { ForwardingRule } from '@freemail/shared';

export interface ListForwardingRulesInput {}

export interface ListForwardingRulesOutput {
  /** Every stored rule, enabled or not. Unordered. */
  readonly rules: readonly ForwardingRule[];
}

export interface CreateForwardingRuleInput extends ForwardingRule {}

export interface CreateForwardingRuleOutput {
  /** False on an id collision, so the caller can retry rather than overwrite a rule. */
  readonly created: boolean;
}

/** Every field but `createdAt`, which an update keeps. */
export interface UpdateForwardingRuleInput extends Omit<ForwardingRule, 'createdAt'> {}

/** The rule as stored after the update. */
export interface UpdateForwardingRuleOutput extends ForwardingRule {}

export interface DeleteForwardingRuleInput {
  readonly id: string;
}

/** Nothing to report: the delete is idempotent, so an unknown id succeeds too. */
export interface DeleteForwardingRuleOutput {}

export interface ForwardingRulesDao {
  /** Every rule (a single-tenant deployment holds a handful; unordered). */
  listForwardingRules(input: ListForwardingRulesInput): Promise<ListForwardingRulesOutput>;

  /** Store a new rule only if its id is unused. */
  createForwardingRule(input: CreateForwardingRuleInput): Promise<CreateForwardingRuleOutput>;

  /** Replace an existing rule's fields; null when no rule has the id (nothing is created). */
  updateForwardingRule(input: UpdateForwardingRuleInput): Promise<UpdateForwardingRuleOutput | null>;

  /** Delete a rule by id. Idempotent — deleting an unknown id is a no-op. */
  deleteForwardingRule(input: DeleteForwardingRuleInput): Promise<DeleteForwardingRuleOutput>;
}
