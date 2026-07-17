import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CustomResource,
  Duration,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_ses as ses,
  aws_ses_actions as actions,
  aws_sqs as sqs,
  custom_resources as cr,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { buildActivateHandlerSource } from '../inbound/activate-rule-set.js';

const HANDLERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'service',
  'src',
  'handlers',
);

export interface InboundConstructProps {
  /** The Route53 zone that owns the email domain — the inbound MX record is written here. */
  hostedZone: route53.IHostedZone;
  /** Domain email is received at (the zone apex or a subdomain). The receipt rule is scoped to it. */
  emailDomain: string;
  /** Deploy region — the inbound SMTP MX target (inbound-smtp.<region>.amazonaws.com) is region-specific. */
  region: string;
  /** Raw inbound MIME is delivered under the `inbound/` prefix of this bucket; parsed attachments go under `attachments/`. */
  mailBucket: s3.Bucket;
  /** Email metadata index — the parser writes each received message here (`pk='INBOUND'`). */
  emailsTable: dynamodb.Table;
}

/** SES writes each received message under this prefix as `<prefix><messageId>`. */
const INBOUND_PREFIX = 'inbound/';
const RECORD_TTL = '1800';

/**
 * Optional inbound receiving: a SES receipt rule set whose single catch-all rule
 * delivers raw MIME to S3, the Route53 MX record that points the email domain at
 * SES's inbound SMTP endpoint, AND the parser pipeline that turns each stored raw
 * message into an indexed, readable record (S3 `ObjectCreated` → parser Lambda →
 * DDB metadata + extracted attachments to S3).
 *
 * Instantiated by the stack only when `config.inbound.enabled` — the deploy-time
 * MX + active-rule-set warnings and the `confirmInboundMx` throw fire first.
 *
 * SES spam/virus scanning is enabled on the rule, so SES prepends
 * `X-SES-Spam-Verdict` / `X-SES-Virus-Verdict` (+ SPF/DKIM/DMARC) headers to the
 * stored MIME. Nothing is dropped at receipt — the parser reads those headers
 * (first occurrence, fail-closed) and owns the quarantine decision.
 */
export class InboundConstruct extends Construct {
  readonly ruleSet: ses.ReceiptRuleSet;

  constructor(scope: Construct, id: string, props: InboundConstructProps) {
    super(scope, id);
    const { hostedZone, emailDomain, region, mailBucket, emailsTable } = props;

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
    this.wireParser(mailBucket, emailsTable);
  }

  /**
   * The MIME-parsing pipeline: an S3 `ObjectCreated` notification on the `inbound/`
   * prefix invokes the parser Lambda, which reads the raw MIME, extracts attachments
   * to `attachments/inbound/...` (a DIFFERENT prefix, so those writes never re-trigger
   * this notification), and writes a metadata row to the emails table.
   *
   * The invocation is asynchronous (S3 → Lambda), so failed events are governed by
   * the Lambda async retry policy + an on-failure SQS DLQ (NOT an SQS-source
   * `maxReceiveCount`). Only unexpected/infra errors reach the DLQ — the handler
   * treats malformed/oversized/over-limit messages as handled quarantine writes and
   * returns success, so a poison message can't spin forever.
   */
  private wireParser(mailBucket: s3.Bucket, emailsTable: dynamodb.Table): void {
    const dlq = new sqs.Queue(this, 'ParserDlq', {
      retentionPeriod: Duration.days(14),
    });

    const parser = new nodejs.NodejsFunction(this, 'ParserFn', {
      entry: join(HANDLERS_DIR, 'inbound.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Sized to hold one capped message + one buffered attachment; parsing a large
      // message is I/O + CPU bound, so allow headroom in time and memory.
      memorySize: 1024,
      timeout: Duration.minutes(1),
      description: 'FreeMail inbound MIME parser (S3 raw MIME → DDB index + attachments to S3).',
      environment: {
        EMAILS_TABLE: emailsTable.tableName,
        MAIL_BUCKET: mailBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'ParserLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // Read raw MIME + head + write extracted attachments + best-effort delete on cleanup.
    mailBucket.grantReadWrite(parser);
    // Conditional put of the metadata row.
    emailsTable.grantWriteData(parser);

    parser.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
      onFailure: new destinations.SqsDestination(dlq),
    });

    // Trigger ONLY on the inbound/ prefix — extracted attachments live elsewhere.
    mailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(parser),
      {
        prefix: INBOUND_PREFIX,
      },
    );
  }

  /**
   * The active SES receipt rule set is an account-global, region-wide singleton —
   * only one is active per region, and CloudFormation cannot set it (there is no
   * "active" property; activation is the `ses:SetActiveReceiptRuleSet` API). Without
   * activation the rule set exists but receives nothing, so a deployer who forgot a
   * manual step would silently get no mail. We auto-activate via a custom resource
   * so "one `cdk deploy` = done" holds.
   *
   * FAIL SAFE (see `decideActivation`): onCreate/Update activates ours only when
   * nothing or ours is already active; if a DIFFERENT set is active it aborts the
   * deploy with a clear error rather than silently clobbering account-global state.
   * That makes teardown trivial — onDelete just deactivates ours (and only if it is
   * still the active set).
   */
  private activateRuleSet(ruleSetName: string): void {
    const onEvent = new lambda.Function(this, 'ActivateRuleSetFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      description: "Activates FreeMail's SES receipt rule set (the region-wide active singleton).",
      code: lambda.Code.fromInline(buildActivateHandlerSource()),
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
