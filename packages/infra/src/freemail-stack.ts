import { Annotations, CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { FreeMailConfig } from '@freemail/shared';
import { DataConstruct } from './constructs/data.js';
import { DnsConstruct } from './constructs/dns.js';

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

    // Insertion points for later slices:
    //   SES  → dns.hostedZone (auth records + optional inbound receipt), data.mailBucket
    //   API  → data.authTable / apiKeysTable / emailsTable / downloadTokensTable
    //   Web  → data.webBucket + CloudFront (dns.hostedZone for a custom app domain)

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
        'to avoid clobbering existing email.',
    );
    if (!config.inbound.confirmInboundMx) {
      throw new Error(
        'Inbound email is enabled but the MX override has not been acknowledged. ' +
          'Set inbound.confirmInboundMx to true (re-run `freemail init` and confirm) before deploying inbound.',
      );
    }
  }
}
