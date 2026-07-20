import {
  Duration,
  RemovalPolicy,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_ses as ses,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SesConstructProps {
  /** The Route53 zone that owns the email domain — all auth records are written here. */
  readonly hostedZone: route53.IHostedZone;
  /** Domain SES sends from (any address under it). The zone apex or a subdomain of it. */
  readonly emailDomain: string;
  /** Deploy region — the custom MAIL FROM MX target (feedback-smtp.<region>.amazonses.com) is region-specific. */
  readonly region: string;
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
  readonly emailIdentity: ses.EmailIdentity;
  readonly configurationSet: ses.ConfigurationSet;
  /** Bounce & complaint notifications, consumed by the audit logger below (add richer consumers later). */
  readonly bounceComplaintTopic: sns.Topic;
  /** Logs every bounce/complaint SNS notification to CloudWatch for audit. */
  readonly bounceComplaintLogger: lambda.Function;
  /** Custom MAIL FROM subdomain (`bounce.<emailDomain>`) — keeps SPF/DMARC aligned with the From domain. */
  readonly mailFromDomain: string;

  constructor(scope: Construct, id: string, props: SesConstructProps) {
    super(scope, id);
    const { hostedZone, emailDomain, region } = props;
    this.mailFromDomain = `bounce.${emailDomain}`;

    this.bounceComplaintTopic = new sns.Topic(this, 'BounceComplaintTopic', {
      displayName: `FreeMail SES bounces & complaints (${emailDomain})`,
    });

    // Enable the account-level suppression list for bounces + complaints so a hard
    // bounce / complaint address is dropped from future sends automatically
    // (reputation), and publish every bounce/complaint to SNS for logging.
    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination('BounceComplaintSns', {
      destination: ses.EventDestination.snsTopic(this.bounceComplaintTopic),
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });
    this.bounceComplaintLogger = this.addBounceComplaintLogger();

    this.emailIdentity = new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.domain(emailDomain),
      configurationSet: this.configurationSet,
      dkimSigning: true,
      mailFromDomain: this.mailFromDomain,
      // We track bounces/complaints via the SNS event destination above, and the
      // MAIL FROM subdomain has no inbox, so email feedback forwarding is off.
      feedbackForwarding: false,
    });

    this.writeAuthRecords(hostedZone, emailDomain, region);
  }

  /**
   * A minimal audit consumer so bounce/complaint events aren't silently discarded:
   * an inline Lambda subscribed to the SNS topic logs each notification to its own
   * CloudWatch log group. Richer handling (alerting, a suppression-audit store) can
   * subscribe to the same topic or replace this later.
   */
  private addBounceComplaintLogger(): lambda.Function {
    const logGroup = new logs.LogGroup(this, 'BounceComplaintLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      // Audit logs, not user data — safe to remove with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logger = new lambda.Function(this, 'BounceComplaintLogger', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(10),
      logGroup,
      description: 'Logs SES bounce/complaint notifications to CloudWatch for audit.',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async (event) => {',
          '  for (const record of event.Records ?? []) {',
          "    console.log('SES bounce/complaint notification', record.Sns?.Message ?? JSON.stringify(record.Sns));",
          '  }',
          '};',
        ].join('\n'),
      ),
    });
    this.bounceComplaintTopic.addSubscription(new subscriptions.LambdaSubscription(logger));
    return logger;
  }

  private writeAuthRecords(
    hostedZone: route53.IHostedZone,
    emailDomain: string,
    region: string,
  ): void {
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
    hostedZone: route53.IHostedZone,
    props: { name: string; type: string; resourceRecords: string[] },
  ): route53.CfnRecordSet {
    return new route53.CfnRecordSet(this, `${id}Record`, {
      hostedZoneId: hostedZone.hostedZoneId,
      name: props.name,
      type: props.type,
      ttl: RECORD_TTL,
      resourceRecords: props.resourceRecords,
    });
  }
}
