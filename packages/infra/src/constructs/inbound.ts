import {
  CustomResource,
  Duration,
  RemovalPolicy,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_ses as ses,
  aws_ses_actions as actions,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface InboundConstructProps {
  /** The Route53 zone that owns the email domain — the inbound MX record is written here. */
  hostedZone: route53.IHostedZone;
  /** Domain email is received at (the zone apex or a subdomain). The receipt rule is scoped to it. */
  emailDomain: string;
  /** Deploy region — the inbound SMTP MX target (inbound-smtp.<region>.amazonaws.com) is region-specific. */
  region: string;
  /** Raw inbound MIME is delivered under the `inbound/` prefix of this bucket. */
  mailBucket: s3.Bucket;
}

/** SES writes each received message under this prefix as `<prefix><messageId>`. */
const INBOUND_PREFIX = 'inbound/';
const RECORD_TTL = '1800';

/**
 * Optional inbound receiving: a SES receipt rule set whose single catch-all rule
 * delivers raw MIME to S3, plus the Route53 MX record that points the email
 * domain at SES's inbound SMTP endpoint. Infra only — no MIME parsing or DDB
 * indexing here (that's the read slice); this just lands `s3://<mailBucket>/inbound/<sesMessageId>`
 * and stands up the DNS/receipt plumbing.
 *
 * Instantiated by the stack only when `config.inbound.enabled` — the deploy-time
 * MX + active-rule-set warnings and the `confirmInboundMx` throw fire first.
 *
 * SES spam/virus scanning is enabled on the rule, so SES prepends
 * `X-SES-Spam-Verdict` / `X-SES-Virus-Verdict` (+ SPF/DKIM/DMARC) headers to the
 * stored MIME. Nothing is dropped here — the read slice reads those headers and
 * owns the quarantine/drop decision.
 */
export class InboundConstruct extends Construct {
  readonly ruleSet: ses.ReceiptRuleSet;

  constructor(scope: Construct, id: string, props: InboundConstructProps) {
    super(scope, id);
    const { hostedZone, emailDomain, region, mailBucket } = props;

    this.ruleSet = new ses.ReceiptRuleSet(this, 'RuleSet');

    // One catch-all rule, scoped to the configured domain. Scoping to `emailDomain`
    // (rather than an empty recipient list) still matches every local part under the
    // domain, but does NOT consume mail for other domains sharing the region's
    // active receipt rule set. `scanEnabled` makes SES run spam/virus scanning and
    // embed the verdict headers in the stored message.
    this.ruleSet.addRule('Catchall', {
      recipients: [emailDomain],
      scanEnabled: true,
      actions: [
        new actions.S3({
          bucket: mailBucket,
          objectKeyPrefix: INBOUND_PREFIX,
        }),
      ],
    });

    // Route the domain's mail to SES. This OVERRIDES any existing MX on the domain
    // — the stack warns about it and gates on `confirmInboundMx`.
    new route53.CfnRecordSet(this, 'InboundMx', {
      hostedZoneId: hostedZone.hostedZoneId,
      name: emailDomain,
      type: 'MX',
      ttl: RECORD_TTL,
      resourceRecords: [`10 inbound-smtp.${region}.amazonaws.com`],
    });

    this.activateRuleSet(this.ruleSet.receiptRuleSetName);
  }

  /**
   * The active SES receipt rule set is an account-global, region-wide singleton —
   * only one is active per region, and CloudFormation cannot set it (there is no
   * "active" property; activation is the `ses:SetActiveReceiptRuleSet` API). Without
   * activation the rule set exists but receives nothing, so a deployer who forgot a
   * manual step would silently get no mail. We auto-activate via a custom resource
   * so "one `cdk deploy` = done" holds.
   *
   * onCreate/Update activates ours (replacing whatever was active — the stack warns
   * about this takeover), logging the previously-active set for recovery. onDelete
   * deactivates ours ONLY if it is still the active set, so tearing down FreeMail
   * never clears an unrelated set that became active in the meantime.
   */
  private activateRuleSet(ruleSetName: string): void {
    const onEvent = new lambda.Function(this, 'ActivateRuleSetFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      description: "Activates FreeMail's SES receipt rule set (the region-wide active singleton).",
      code: lambda.Code.fromInline(ACTIVATE_RULE_SET_SOURCE),
      // This handler logs the previously-active rule set on takeover (recovery info),
      // so give it a retained, disposable log group rather than the unbounded default.
      logGroup: new logs.LogGroup(this, 'ActivateRuleSetLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        // Receipt-rule-set activation is account-level; SES does not support
        // resource-scoping these actions.
        actions: ['ses:DescribeActiveReceiptRuleSet', 'ses:SetActiveReceiptRuleSet'],
        resources: ['*'],
      }),
    );

    const provider = new cr.Provider(this, 'ActivateRuleSetProvider', {
      onEventHandler: onEvent,
    });

    new CustomResource(this, 'ActivateRuleSet', {
      serviceToken: provider.serviceToken,
      properties: { RuleSetName: ruleSetName },
    });
  }
}

/**
 * CloudFormation custom-resource handler (run by the CDK Provider framework, which
 * owns the response protocol — this just implements the logic). Uses the SES v1
 * client bundled in the Lambda runtime; no build-time dependency.
 */
const ACTIVATE_RULE_SET_SOURCE = [
  "const { SESClient, DescribeActiveReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand } = require('@aws-sdk/client-ses');",
  'const ses = new SESClient({});',
  'exports.handler = async (event) => {',
  '  const ruleSetName = event.ResourceProperties.RuleSetName;',
  '  const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));',
  '  const activeName = active && active.Metadata ? active.Metadata.Name : undefined;',
  "  if (event.RequestType === 'Delete') {",
  '    if (activeName === ruleSetName) {',
  '      await ses.send(new SetActiveReceiptRuleSetCommand({}));',
  "      console.log('Deactivated FreeMail receipt rule set', ruleSetName);",
  '    } else {',
  "      console.log('Active receipt rule set is not ours; leaving it untouched', { activeName, ruleSetName });",
  '    }',
  '    return { PhysicalResourceId: event.PhysicalResourceId };',
  '  }',
  '  if (activeName && activeName !== ruleSetName) {',
  "    console.warn('Replacing previously-active SES receipt rule set', { previous: activeName, now: ruleSetName });",
  '  }',
  '  await ses.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: ruleSetName }));',
  "  console.log('Activated FreeMail receipt rule set', ruleSetName);",
  '  return {',
  '    PhysicalResourceId: ruleSetName,',
  "    Data: { PreviousActiveRuleSet: activeName && activeName !== ruleSetName ? activeName : '' },",
  '  };',
  '};',
].join('\n');
