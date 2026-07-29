import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnRecordSet, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  ConfigurationSet,
  EmailIdentity,
  EmailSendingEvent,
  EventDestination,
  Identity,
  SuppressionReasons,
} from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { InboundConstruct } from './inbound.js';

export interface SesConstructProps {
  /** The Route53 zone that owns the email domain — all auth records are written here. */
  readonly hostedZone: IHostedZone;
  /** Domain SES sends from (any address under it). The zone apex or a subdomain of it. */
  readonly emailDomain: string;
  /** Deploy region — the custom MAIL FROM MX target (feedback-smtp.<region>.amazonses.com) is region-specific. */
  readonly region: string;
  /**
   * The mail stores the inbound pipeline needs, present ONLY when inbound email is
   * enabled (the stack passes this iff `config.inbound.enabled`). When present, SES
   * instantiates the inbound receipt pipeline as a child; absent → SES is send-only.
   */
  readonly inbound?: {
    /** Raw inbound MIME is delivered under `inbound/` of this bucket; parsed attachments under `attachments/`. */
    readonly mailBucket: Bucket;
    /** The parser writes each received message's metadata row here (`pk='INBOUND'`). */
    readonly emailsTable: Table;
  };
}

const RECORD_TTL = '1800';
const SPF_VALUE = 'v=spf1 include:amazonses.com ~all';
// p=none = monitoring only: start here, then tighten to quarantine/reject once
// aligned SPF/DKIM is confirmed via the aggregate reports.
const DMARC_VALUE = 'v=DMARC1; p=none;';

/** Route53 stores TXT record values enclosed in double quotes. */
function txt(value: string): string {
  return `"${value}"`;
}

/**
 * SES sending for the email domain, with the full set of deliverability records
 * (DKIM, SPF, custom MAIL FROM, DMARC) written into the Route53 zone, plus a
 * configuration set that auto-suppresses bounced/complained addresses and fans
 * every bounce/complaint out to SNS, where an audit Lambda logs them to CloudWatch.
 *
 * The identity is a plain `Identity.domain` (not `publicHostedZone`) so it works
 * whether `emailDomain` is the zone apex or a subdomain, and so every DNS record
 * is created explicitly — the auto-created L2 `CnameRecord` double-suffixes the
 * already-fully-qualified DKIM token host, so raw `CfnRecordSet`s are used instead.
 */
export class SesConstruct extends Construct {
  readonly emailIdentity: EmailIdentity;
  readonly configurationSet: ConfigurationSet;
  /** Bounce & complaint notifications, consumed by the audit logger below (add richer consumers later). */
  readonly bounceComplaintTopic: Topic;
  /** Logs every bounce/complaint SNS notification to CloudWatch for audit. */
  readonly bounceComplaintLogger: LambdaFunction;
  /** Custom MAIL FROM subdomain (`bounce.<emailDomain>`) — keeps SPF/DMARC aligned with the From domain. */
  readonly mailFromDomain: string;

  constructor(scope: Construct, id: string, props: SesConstructProps) {
    super(scope, id);
    const { hostedZone, emailDomain, region } = props;
    this.mailFromDomain = `bounce.${emailDomain}`;

    this.bounceComplaintTopic = new Topic(this, 'BounceComplaintTopic', {
      displayName: `FreeMail SES bounces & complaints (${emailDomain})`,
    });

    // Enable the account-level suppression list for bounces + complaints so a hard
    // bounce / complaint address is dropped from future sends automatically
    // (reputation), and publish every bounce/complaint to SNS for logging.
    this.configurationSet = new ConfigurationSet(this, 'ConfigSet', {
      reputationMetrics: true,
      suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination('BounceComplaintSns', {
      destination: EventDestination.snsTopic(this.bounceComplaintTopic),
      events: [
        EmailSendingEvent.BOUNCE,
        EmailSendingEvent.COMPLAINT,
        EmailSendingEvent.REJECT,
        EmailSendingEvent.DELIVERY_DELAY,
      ],
    });
    this.bounceComplaintLogger = this.addBounceComplaintLogger();

    this.emailIdentity = new EmailIdentity(this, 'Identity', {
      identity: Identity.domain(emailDomain),
      configurationSet: this.configurationSet,
      dkimSigning: true,
      mailFromDomain: this.mailFromDomain,
      // We track bounces/complaints via the SNS event destination above, and the
      // MAIL FROM subdomain has no inbox, so email feedback forwarding is off.
      feedbackForwarding: false,
    });

    this.writeAuthRecords(hostedZone, emailDomain, region);

    // SES owns its inbound receipt setup too: when inbound is enabled the stack passes
    // the mail bucket + emails table, and this construct instantiates the inbound
    // pipeline (receipt rule set → S3 + MX + parser) as a child. Absent → send-only.
    // The stack's `confirmInboundMx` acknowledgement gate still fires first, at synth.
    if (props.inbound) {
      new InboundConstruct(this, 'Inbound', {
        hostedZone,
        emailDomain,
        region,
        mailBucket: props.inbound.mailBucket,
        emailsTable: props.inbound.emailsTable,
      });
    }
  }

  /**
   * A minimal audit consumer so bounce/complaint events aren't silently discarded:
   * an inline Lambda subscribed to the SNS topic logs each notification to its own
   * CloudWatch log group. Richer handling (alerting, a suppression-audit store) can
   * subscribe to the same topic or replace this later.
   */
  private addBounceComplaintLogger(): LambdaFunction {
    const logGroup = new LogGroup(this, 'BounceComplaintLogGroup', {
      retention: RetentionDays.THREE_MONTHS,
      // Audit logs, not user data — safe to remove with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logger = new LambdaFunction(this, 'BounceComplaintLogger', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(10),
      logGroup,
      description: 'Logs SES bounce/complaint notifications to CloudWatch for audit.',
      code: Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  for (const record of event.Records ?? []) {',
          "    console.log('SES bounce/complaint notification', record.Sns?.Message ?? JSON.stringify(record.Sns));",
          '  }',
          '};',
        ].join('\n'),
      ),
    });
    this.bounceComplaintTopic.addSubscription(new LambdaSubscription(logger));
    return logger;
  }

  private writeAuthRecords(hostedZone: IHostedZone, emailDomain: string, region: string): void {
    // Easy DKIM: 3 CNAMEs. `record.name` is already the fully-qualified host, so a
    // raw CfnRecordSet (which does no FQDN munging) is required — the L2
    // CnameRecord would append the zone name a second time and break DKIM.
    this.emailIdentity.dkimRecords.forEach((record, index) => {
      this.record(`Dkim${index + 1}`, hostedZone, {
        name: record.name,
        type: 'CNAME',
        resourceRecords: [record.value],
      });
    });

    // SPF for the From domain.
    this.record('Spf', hostedZone, {
      name: emailDomain,
      type: 'TXT',
      resourceRecords: [txt(SPF_VALUE)],
    });

    // Custom MAIL FROM: MX → the region's feedback SMTP endpoint, plus its own SPF.
    this.record('MailFromMx', hostedZone, {
      name: this.mailFromDomain,
      type: 'MX',
      resourceRecords: [`10 feedback-smtp.${region}.amazonses.com`],
    });
    this.record('MailFromSpf', hostedZone, {
      name: this.mailFromDomain,
      type: 'TXT',
      resourceRecords: [txt(SPF_VALUE)],
    });

    // DMARC (monitoring; p=none).
    this.record('Dmarc', hostedZone, {
      name: `_dmarc.${emailDomain}`,
      type: 'TXT',
      resourceRecords: [txt(DMARC_VALUE)],
    });
  }

  private record(
    id: string,
    hostedZone: IHostedZone,
    props: { name: string; type: string; resourceRecords: string[] },
  ): CfnRecordSet {
    return new CfnRecordSet(this, `${id}Record`, {
      hostedZoneId: hostedZone.hostedZoneId,
      name: props.name,
      type: props.type,
      ttl: RECORD_TTL,
      resourceRecords: props.resourceRecords,
    });
  }
}
