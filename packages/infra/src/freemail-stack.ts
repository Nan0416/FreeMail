import { Annotations, CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { FreeMailConfig } from '@freemail/shared';
import { ApiConstruct } from './constructs/api.js';
import { DataConstruct } from './constructs/data.js';
import { DnsConstruct } from './constructs/dns.js';
import { InboundConstruct } from './constructs/inbound.js';
import { SesConstruct } from './constructs/ses.js';
import { WebConstruct, resolveWebAssetPath } from './constructs/web.js';

export interface FreeMailStackProps extends StackProps {
  config: FreeMailConfig;
}

/**
 * The single FreeMail stack. Single-tenant, single-account, single-region (pinned
 * us-east-1), so one stack + one `cdk deploy` is the whole deployment — later
 * slices (SES, API, MCP, web) add their constructs here, consuming the DNS zone
 * and data stores exposed below rather than reaching across stack boundaries.
 */
export class FreeMailStack extends Stack {
  constructor(scope: Construct, id: string, props: FreeMailStackProps) {
    const { config } = props;
    super(scope, id, { ...props, env: { ...props.env, region: config.region } });

    this.assertInboundAcknowledged(config);

    const dns = new DnsConstruct(this, 'Dns', { hostedZone: config.hostedZone });
    const data = new DataConstruct(this, 'Data');
    const ses = new SesConstruct(this, 'Ses', {
      hostedZone: dns.hostedZone,
      emailDomain: config.emailDomain,
      region: config.region,
    });

    const api = new ApiConstruct(this, 'Api', {
      authTable: data.authTable,
      apiKeysTable: data.apiKeysTable,
      emailsTable: data.emailsTable,
      downloadTokensTable: data.downloadTokensTable,
      mailBucket: data.mailBucket,
      emailDomain: config.emailDomain,
      sesConfigurationSetName: ses.configurationSet.configurationSetName,
    });

    // The React SPA on CloudFront + S3, learning the API endpoint at runtime.
    const web = new WebConstruct(this, 'Web', {
      webBucket: data.webBucket,
      apiEndpoint: api.httpApi.apiEndpoint,
      assetPath: resolveWebAssetPath(),
      inboundEnabled: config.inbound.enabled,
    });

    // Optional inbound: SES receipt rule set → S3 + the inbound MX record. Gated on
    // config; the warn/throw acknowledgement above fires first.
    if (config.inbound.enabled) {
      new InboundConstruct(this, 'Inbound', {
        hostedZone: dns.hostedZone,
        emailDomain: config.emailDomain,
        region: config.region,
        mailBucket: data.mailBucket,
        emailsTable: data.emailsTable,
      });
    }

    // Insertion points for later slices:
    //   Web  → a custom app domain (dns.hostedZone + ACM) is Phase 3 (#15)

    new CfnOutput(this, 'HostedZoneId', { value: dns.hostedZone.hostedZoneId });
    if (config.hostedZone.mode === 'create' && dns.nameServers) {
      new CfnOutput(this, 'HostedZoneNameServers', {
        description:
          'Set these name servers at your domain registrar to activate the created zone.',
        value: Fn.join(', ', dns.nameServers),
      });
    }
    new CfnOutput(this, 'MailBucketName', { value: data.mailBucket.bucketName });
    new CfnOutput(this, 'WebBucketName', { value: data.webBucket.bucketName });

    new CfnOutput(this, 'ApiEndpoint', {
      description: 'Base URL of the FreeMail HTTP API.',
      value: api.httpApi.apiEndpoint,
    });

    new CfnOutput(this, 'WebAppUrl', {
      description: 'CloudFront URL of the FreeMail web app.',
      value: `https://${web.distribution.distributionDomainName}`,
    });

    new CfnOutput(this, 'SesIdentityName', { value: ses.emailIdentity.emailIdentityName });
    new CfnOutput(this, 'SesMailFromDomain', { value: ses.mailFromDomain });
    new CfnOutput(this, 'SesBounceComplaintTopicArn', {
      value: ses.bounceComplaintTopic.topicArn,
    });
    // SES starts every account in SANDBOX mode (verified recipients only, ~200/day).
    // Requesting production access is a one-time manual per-account step.
    new CfnOutput(this, 'SesProductionAccessNote', {
      description:
        'SES starts in SANDBOX mode (verified recipients only, ~200 msgs/day). Request production ' +
        'access (SES console → Account dashboard → Request production access) before sending to ' +
        'arbitrary recipients — a one-time manual per-account step.',
      value: `https://console.aws.amazon.com/ses/home?region=${config.region}#/account`,
    });
  }

  /**
   * Enabling inbound points the email domain's MX record at SES, overriding any
   * existing mail routing. We always warn at synth, and refuse to synthesize
   * inbound unless the deployer has explicitly acknowledged the override — the
   * `freemail init` CLI captures that acknowledgement.
   */
  private assertInboundAcknowledged(config: FreeMailConfig): void {
    if (!config.inbound.enabled) {
      return;
    }
    Annotations.of(this).addWarning(
      `Inbound email is ENABLED: FreeMail will set the MX record for "${config.emailDomain}" to AWS SES, ` +
        'overriding any existing mail routing for that domain. Use a dedicated subdomain (e.g. mail.example.com) ' +
        "to avoid clobbering existing email. It will also make FreeMail's SES receipt rule set the region's " +
        'single active set (an account-global, region-wide singleton). If a DIFFERENT receipt rule set is ' +
        'already active in this account/region, the deploy FAILS rather than overriding it — deactivate that ' +
        'set, or deploy FreeMail to a dedicated account/region, before enabling inbound.',
    );
    if (!config.inbound.confirmInboundMx) {
      throw new Error(
        'Inbound email is enabled but the MX override has not been acknowledged. ' +
          'Set inbound.confirmInboundMx to true (re-run `freemail init` and confirm) before deploying inbound.',
      );
    }
  }
}
