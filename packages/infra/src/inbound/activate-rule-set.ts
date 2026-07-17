/**
 * Decision logic for the SES-receipt-rule-set activation custom resource, kept as
 * a pure, self-contained function so it can be unit-tested directly AND embedded
 * verbatim (via `Function.prototype.toString`) into the Lambda handler source —
 * so the deployed code IS the tested code, with no duplication and no runtime
 * SDK dependency at build time.
 *
 * The active SES receipt rule set is an account-global, region-wide singleton
 * (only one active per region), and CloudFormation cannot set it. We auto-activate
 * via this custom resource, but FAIL SAFE: we never silently replace a foreign
 * active rule set — a synth warning is missable in CI/automated deploys, and the
 * clobber is silent + destructive + account-global, so a conflict aborts the
 * deploy with a clear, actionable error instead.
 */

export type ActivationRequestType = 'Create' | 'Update' | 'Delete';

export type ActivationDecision =
  { readonly action: 'activate' } | { readonly action: 'deactivate' } | { readonly action: 'noop' };

/**
 * Decide what to do with the region's active receipt rule set.
 *
 * - Create/Update: activate ours when nothing is active or ours already is; if a
 *   DIFFERENT set is active, throw (fail the deploy) naming the conflict.
 * - Delete: deactivate ours only if it is still the active set; otherwise no-op,
 *   so tearing down FreeMail never clears an unrelated set that became active in
 *   the meantime.
 *
 * Self-contained: references only its parameters and `Error` (no imports, no
 * closure, no module state) so `toString()` yields runnable Lambda source.
 */
export function decideActivation(
  requestType: ActivationRequestType,
  activeRuleSetName: string | undefined,
  ourRuleSetName: string,
): ActivationDecision {
  if (requestType === 'Delete') {
    return activeRuleSetName === ourRuleSetName ? { action: 'deactivate' } : { action: 'noop' };
  }
  if (activeRuleSetName && activeRuleSetName !== ourRuleSetName) {
    throw new Error(
      `SES receipt rule set "${activeRuleSetName}" is already the active set in this region; ` +
        `FreeMail will not override it. Deactivate it, or deploy FreeMail to a dedicated ` +
        `AWS account/region, before enabling inbound. (The active receipt rule set is an ` +
        `account-global, region-wide singleton.)`,
    );
  }
  return { action: 'activate' };
}

/**
 * Assemble the inline Lambda handler source. Embeds `decideActivation` verbatim
 * and wraps it with the SES calls + the CDK custom-resource response shape. The
 * SES v1 client (receipt-rule APIs are not in SESv2) is `require`d from the Lambda
 * runtime's bundled AWS SDK — no build-time dependency.
 */
export function buildActivateHandlerSource(): string {
  return [
    "const { SESClient, DescribeActiveReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand } = require('@aws-sdk/client-ses');",
    `const decideActivation = ${decideActivation.toString()};`,
    'exports.handler = async (event) => {',
    '  const ruleSetName = event.ResourceProperties.RuleSetName;',
    '  const ses = new SESClient({});',
    '  const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));',
    '  const activeName = active && active.Metadata ? active.Metadata.Name : undefined;',
    '  const decision = decideActivation(event.RequestType, activeName, ruleSetName);',
    "  if (decision.action === 'activate') {",
    '    await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: ruleSetName }));',
    "    console.log('Activated FreeMail SES receipt rule set', ruleSetName);",
    "  } else if (decision.action === 'deactivate') {",
    '    await ses.send(new SetActiveReceiptRuleSetCommand({}));',
    "    console.log('Deactivated FreeMail SES receipt rule set', ruleSetName);",
    '  } else {',
    "    console.log('No active-rule-set change needed', { requestType: event.RequestType, activeName, ruleSetName });",
    '  }',
    '  return { PhysicalResourceId: event.PhysicalResourceId || ruleSetName };',
    '};',
  ].join('\n');
}
