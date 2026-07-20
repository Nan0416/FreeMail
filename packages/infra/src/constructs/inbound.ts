import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnRecordSet, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { EventType, type Bucket } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { ReceiptRuleSet } from 'aws-cdk-lib/aws-ses';
import { S3 as S3Action } from 'aws-cdk-lib/aws-ses-actions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Provider } from 'aws-cdk-lib/custom-resources';
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
  readonly hostedZone: IHostedZone;
  /** Domain email is received at (the zone apex or a subdomain). The receipt rule is scoped to it. */
  readonly emailDomain: string;
  /** Deploy region — the inbound SMTP MX target (inbound-smtp.<region>.amazonaws.com) is region-specific. */
  readonly region: string;
  /** Raw inbound MIME is delivered under the `inbound/` prefix of this bucket; parsed attachments go under `attachments/`. */
  readonly mailBucket: Bucket;
  /** Email metadata index — the parser writes each received message here (`pk='INBOUND'`). */
  readonly emailsTable: Table;
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
  readonly ruleSet: ReceiptRuleSet;

  constructor(scope: Construct, id: string, props: InboundConstructProps) {
    super(scope, id);
    const { hostedZone, emailDomain, region, mailBucket, emailsTable } = props;

    this.ruleSet = new ReceiptRuleSet(this, 'RuleSet');

    // One catch-all rule, scoped to the configured domain. Scoping to `emailDomain`
    // (rather than an empty recipient list) still matches every local part under the
    // domain, but does NOT consume mail for other domains sharing the region's
    // active receipt rule set. `scanEnabled` makes SES run spam/virus scanning and
    // embed the verdict headers in the stored message.
    this.ruleSet.addRule('Catchall', {
      recipients: [emailDomain],
      scanEnabled: true,
      actions: [
        new S3Action({
          bucket: mailBucket,
          objectKeyPrefix: INBOUND_PREFIX,
        }),
      ],
    });

    // Route the domain's mail to SES. This OVERRIDES any existing MX on the domain
    // — the stack warns about it and gates on `confirmInboundMx`.
    new CfnRecordSet(this, 'InboundMx', {
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
  private wireParser(mailBucket: Bucket, emailsTable: Table): void {
    const dlq = new Queue(this, 'ParserDlq', {
      retentionPeriod: Duration.days(14),
    });

    const parser = new NodejsFunction(this, 'ParserFn', {
      entry: join(HANDLERS_DIR, 'inbound.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // Sized to hold one capped message + one buffered attachment; parsing a large
      // message is I/O + CPU bound, so allow headroom in time and memory.
      memorySize: 1024,
      timeout: Duration.minutes(1),
      description: 'FreeMail inbound MIME parser (S3 raw MIME → DDB index + attachments to S3).',
      environment: {
        EMAILS_TABLE: emailsTable.tableName,
        MAIL_BUCKET: mailBucket.bucketName,
      },
      logGroup: new LogGroup(this, 'ParserLogs', {
        retention: RetentionDays.THREE_MONTHS,
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
      onFailure: new SqsDestination(dlq),
    });

    // Trigger ONLY on the inbound/ prefix — extracted attachments live elsewhere.
    mailBucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(parser), {
      prefix: INBOUND_PREFIX,
    });
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
    const onEvent = new LambdaFunction(this, 'ActivateRuleSetFn', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      description: "Activates FreeMail's SES receipt rule set (the region-wide active singleton).",
      code: Code.fromInline(buildActivateHandlerSource()),
      logGroup: new LogGroup(this, 'ActivateRuleSetLogs', {
        retention: RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    onEvent.addToRolePolicy(
      new PolicyStatement({
        // Receipt-rule-set activation is account-level; SES does not support
        // resource-scoping these actions.
        actions: ['ses:DescribeActiveReceiptRuleSet', 'ses:SetActiveReceiptRuleSet'],
        resources: ['*'],
      }),
    );

    const provider = new Provider(this, 'ActivateRuleSetProvider', {
      onEventHandler: onEvent,
    });

    new CustomResource(this, 'ActivateRuleSet', {
      serviceToken: provider.serviceToken,
      properties: { RuleSetName: ruleSetName },
    });
  }
}
