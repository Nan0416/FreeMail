import { Annotations, CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { FreeMailConfig } from '@freemail/shared/config';
import { ApiConstruct } from './constructs/api.js';
import { DataConstruct } from './constructs/data.js';
import { DnsConstruct } from './constructs/dns.js';
import { SesConstruct } from './constructs/ses.js';
import { WebConstruct, resolveWebAssetPath } from './constructs/web.js';

export interface FreeMailStackProps extends StackProps {
  readonly config: FreeMailConfig;
}

/**
 * The single FreeMail stack. Single-tenant, single-account, single-region (pinned
 * us-east-1), so one stack + one `cdk deploy` is the whole deployment — later
 * slices (SES, API, MCP, web) add their constructs here, consuming the DNS zone
 * and data stores exposed below rather than reaching across stack boundaries.
 */
export class FreeMailStack extends Stack {
  constructor(scope: Construct, id: string, props: FreeMailStackProps) {
    super(scope, id, { ...props, env: { ...props.env, region: props.config.region } });

    this.assertInboundAcknowledged(props.config);
    this.warnCustomDomainDelegation(props.config);

    const dns = new DnsConstruct(this, 'Dns', { hostedZone: props.config.hostedZone });
    const appOrigin = `https://${props.config.appDomain}`;
    const apiBaseUrl = `https://${props.config.apiDomain}`;
    const data = new DataConstruct(this, 'Data', { appOrigin });
    // Where the browser PUTs attachment uploads (the presigned URLs' virtual-hosted S3 host).
    const uploadOrigin = `https://${data.mailBucket.bucketName}.s3.${props.config.region}.amazonaws.com`;
    const ses = new SesConstruct(this, 'Ses', {
      hostedZone: dns.hostedZone,
      emailDomain: props.config.emailDomain,
      region: props.config.region,
      sesIdentityMode: props.config.sesIdentity.mode,
      // SES owns inbound too: pass the mail stores only when inbound is enabled, and
      // the construct instantiates the receipt pipeline as a child. The confirmInboundMx
      // acknowledgement gate (assertInboundAcknowledged, above) still fires first.
      ...(props.config.inbound.enabled
        ? {
            inbound: {
              mailBucket: data.mailBucket,
              emailsTable: data.emailsTable,
              quarantineBucket: data.quarantineBucket,
            },
          }
        : {}),
    });

    // Both custom domains are required (#47), so these origins always exist. The app
    // origin is what the API's CORS policy allowlists; the api origin is what the SPA
    // calls and what the app CSP's connect-src names.
    const api = new ApiConstruct(this, 'Api', {
      authTable: data.authTable,
      apiKeysTable: data.apiKeysTable,
      emailsTable: data.emailsTable,
      downloadTokensTable: data.downloadTokensTable,
      mailBucket: data.mailBucket,
      quarantineBucket: data.quarantineBucket,
      emailDomain: props.config.emailDomain,
      sesConfigurationSetName: ses.configurationSet.configurationSetName,
      inboundEnabled: props.config.inbound.enabled,
      customDomain: { domainName: props.config.apiDomain, hostedZone: dns.hostedZone },
      appOrigin,
      ...(props.config.attachments ? { attachments: props.config.attachments } : {}),
    });
    // Received copies of your own sends recognize their download links (built from the API's
    // endpoint) and carry the linked files as attachments.
    ses.inbound?.linkOwnDownloads(data.downloadTokensTable, api.httpApi.apiEndpoint);

    // The React SPA on CloudFront + S3, learning the API origin at runtime. SPA-only
    // as of #47 — the `/api/*` proxy behavior is gone and the browser calls the API
    // cross-origin at `apiBaseUrl`.
    const web = new WebConstruct(this, 'Web', {
      apiBaseUrl,
      uploadOrigin,
      assetPath: resolveWebAssetPath(),
      inboundEnabled: props.config.inbound.enabled,
      customDomain: { domainName: props.config.appDomain, hostedZone: dns.hostedZone },
    });

    new CfnOutput(this, 'HostedZoneId', { value: dns.hostedZone.hostedZoneId });
    if (props.config.hostedZone.mode === 'create' && dns.nameServers) {
      new CfnOutput(this, 'HostedZoneNameServers', {
        description:
          'Set these name servers at your domain registrar to activate the created zone.',
        value: Fn.join(', ', dns.nameServers),
      });
    }
    new CfnOutput(this, 'MailBucketName', { value: data.mailBucket.bucketName });
    new CfnOutput(this, 'QuarantineBucketName', { value: data.quarantineBucket.bucketName });
    new CfnOutput(this, 'WebBucketName', { value: web.webBucket.bucketName });

    new CfnOutput(this, 'ApiEndpoint', {
      description:
        'Generated execute-api URL of the FreeMail HTTP API. Callers should use the api ' +
        'custom domain (ApiCustomDomainUrl) instead — the session cookies are __Host- ' +
        'prefixed and therefore host-locked to it.',
      value: api.httpApi.apiEndpoint,
    });
    new CfnOutput(this, 'ApiCustomDomainUrl', {
      description:
        'The API domain. Used by BOTH the web app (cross-origin, credentialed CORS) and ' +
        'agents/MCP (x-api-key).',
      value: `https://${api.customDomainName}`,
    });

    new CfnOutput(this, 'WebAppUrl', {
      description: 'URL of the FreeMail web app (the configured app domain).',
      value: `https://${web.customDomainName}`,
    });
    // Always surface the raw CloudFront domain — the alias target + a DNS/debug fallback.
    new CfnOutput(this, 'WebDistributionDomainName', {
      description: 'Generated CloudFront domain of the web distribution.',
      value: web.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'CustomDomainValidationNote', {
      description:
        'Custom-domain ACM certs are DNS-validated via the hosted zone. If the zone was just ' +
        'CREATED, delegate its name servers at your registrar or the deploy hangs on validation.',
      value: 'DNS-validated ACM (us-east-1) via Route53',
    });

    // The identity name IS the domain in both modes, so this reads from config rather
    // than the construct — in import mode there is no construct to read from.
    new CfnOutput(this, 'SesIdentityName', {
      description:
        props.config.sesIdentity.mode === 'import'
          ? 'SES domain identity (IMPORTED — FreeMail did not create it or its auth records).'
          : 'SES domain identity created by FreeMail.',
      value: props.config.emailDomain,
    });
    if (ses.mailFromDomain) {
      new CfnOutput(this, 'SesMailFromDomain', { value: ses.mailFromDomain });
    }
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
      value: `https://console.aws.amazon.com/ses/home?region=${props.config.region}#/account`,
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
    // Import mode means the domain is ALREADY set up for SES outside FreeMail, which
    // makes it the likeliest case to already have working mail delivery to clobber.
    if (config.sesIdentity.mode === 'import') {
      Annotations.of(this).addWarning(
        `The SES identity for "${config.emailDomain}" is IMPORTED, so this domain already has an ` +
          'email setup FreeMail does not own — and enabling inbound will still repoint its MX ' +
          'record at SES, overriding however that domain receives mail today. If anything ' +
          'currently delivers to it, receive on a dedicated subdomain instead.',
      );
    }
    if (!config.inbound.confirmInboundMx) {
      throw new Error(
        'Inbound email is enabled but the MX override has not been acknowledged. ' +
          'Set inbound.confirmInboundMx to true (re-run `freemail init` and confirm) before deploying inbound.',
      );
    }
  }

  /**
   * DNS-validated ACM certificates BLOCK the CloudFormation deploy until their
   * validation records resolve publicly. A freshly CREATED hosted zone is not yet
   * delegated at the registrar, so the first deploy that adds a custom domain will
   * HANG on certificate validation until the name servers are set (unlike SES DKIM,
   * which verifies asynchronously after the deploy). Warn — but don't block, since the
   * deployer may delegate the name servers as part of the same flow.
   */
  private warnCustomDomainDelegation(config: FreeMailConfig): void {
    // Custom domains are always configured (#47), so the only question is whether the
    // zone is new and therefore not yet delegated.
    if (config.hostedZone.mode !== 'create') {
      return;
    }
    Annotations.of(this).addWarning(
      'Custom domains are configured on a CREATED hosted zone. Custom-domain ACM certificates are ' +
        'DNS-validated, and that validation BLOCKS the deploy until the records resolve publicly — so ' +
        'the FIRST deploy will HANG on certificate validation until you delegate the zone. Set the hosted ' +
        'zone name servers (the HostedZoneNameServers output) at your domain registrar before, or promptly ' +
        'during, the deploy. Unlike SES DKIM verification, this is not asynchronous — it gates the deploy.',
    );
  }
}
