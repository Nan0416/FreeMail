/**
 * DynamoDB-backed {@link ForwardingRulesDao} over the forwarding rules table (partition key `id`,
 * no sort key). One row per rule, exactly the wire `ForwardingRule`:
 *   { id, name, enabled, senderDomains, senderAddresses, recipientDomains, recipientAddresses,
 *     forwardTo, ignoreDmarcVerification, createdAt, updatedAt }
 *
 * Create is a conditional put (`attribute_not_exists(id)`) so an id collision never clobbers a
 * rule; update is conditional on the row existing (`attribute_exists(id)`) so editing a rule
 * deleted meanwhile never resurrects it. List is a paginated scan: a single-tenant deployment
 * holds a handful of rules, so there is no index to maintain.
 */
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ForwardingRule } from '@freemail/shared';
import type {
  CreateForwardingRuleInput,
  CreateForwardingRuleOutput,
  DeleteForwardingRuleInput,
  DeleteForwardingRuleOutput,
  ForwardingRulesDao,
  ListForwardingRulesInput,
  ListForwardingRulesOutput,
  UpdateForwardingRuleInput,
  UpdateForwardingRuleOutput,
} from './forwarding-rules-dao.js';
import { ForwardingRuleEntity, isConditionalCheckFailed } from './entities.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('DdbForwardingRulesDao');

/** The fields an update replaces, in the order its expression sets them. */
const UPDATED_FIELDS = [
  'name',
  'enabled',
  'senderDomains',
  'senderAddresses',
  'recipientDomains',
  'recipientAddresses',
  'forwardTo',
  'ignoreDmarcVerification',
  'updatedAt',
] as const satisfies readonly (keyof UpdateForwardingRuleInput)[];

export class DdbForwardingRulesDao implements ForwardingRulesDao {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.doc = doc;
  }

  async listForwardingRules(_input: ListForwardingRulesInput): Promise<ListForwardingRulesOutput> {
    const rules: ForwardingRule[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.doc.send(new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: lastKey }));
      for (const item of result.Items ?? []) {
        const rule = toRule(item);
        if (rule) {
          rules.push(rule);
        } else {
          // Never thrown: one bad row must not stop every other rule from forwarding.
          logger.warn(`Skipping a malformed forwarding rule row (id ${String(item.id)}).`);
        }
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return { rules };
  }

  async createForwardingRule(input: CreateForwardingRuleInput): Promise<CreateForwardingRuleOutput> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: toItem(input),
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      return { created: true };
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return { created: false };
      }
      throw error;
    }
  }

  async updateForwardingRule(input: UpdateForwardingRuleInput): Promise<UpdateForwardingRuleOutput | null> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    for (const field of UPDATED_FIELDS) {
      names[`#${field}`] = field;
      values[`:${field}`] = input[field];
      sets.push(`#${field} = :${field}`);
    }
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: ForwardingRuleEntity.key(input.id),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(id)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      const rule = toRule(result.Attributes);
      if (!rule) {
        throw new Error(`Forwarding rule ${input.id} is malformed after its update.`);
      }
      return rule;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteForwardingRule(input: DeleteForwardingRuleInput): Promise<DeleteForwardingRuleOutput> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: ForwardingRuleEntity.key(input.id) }));
    return {};
  }
}

function toItem(rule: ForwardingRule): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    senderDomains: [...rule.senderDomains],
    senderAddresses: [...rule.senderAddresses],
    recipientDomains: [...rule.recipientDomains],
    recipientAddresses: [...rule.recipientAddresses],
    forwardTo: [...rule.forwardTo],
    ignoreDmarcVerification: rule.ignoreDmarcVerification,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

/** A stored row as a rule, or null when a field is missing or mistyped. */
function toRule(item: Record<string, unknown> | undefined): ForwardingRule | null {
  if (
    !item ||
    typeof item.id !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.enabled !== 'boolean' ||
    typeof item.ignoreDmarcVerification !== 'boolean' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string'
  ) {
    return null;
  }
  const senderDomains = stringList(item.senderDomains);
  const senderAddresses = stringList(item.senderAddresses);
  const recipientDomains = stringList(item.recipientDomains);
  const recipientAddresses = stringList(item.recipientAddresses);
  const forwardTo = stringList(item.forwardTo);
  if (!senderDomains || !senderAddresses || !recipientDomains || !recipientAddresses || !forwardTo) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    senderDomains,
    senderAddresses,
    recipientDomains,
    recipientAddresses,
    forwardTo,
    ignoreDmarcVerification: item.ignoreDmarcVerification,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return null;
  }
  return value as string[];
}
