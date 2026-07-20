import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import type { HostedZoneConfig } from '@freemail/shared';

export interface DnsConstructProps {
  readonly hostedZone: HostedZoneConfig;
}

/**
 * Resolves the Route53 hosted zone — importing an existing one or creating a new
 * one — and exposes it for the SES / CloudFront / API slices to add records to.
 */
export class DnsConstruct extends Construct {
  readonly hostedZone: IHostedZone;
  /** Name servers for a newly-created zone (the deployer must set these at their registrar). Undefined when imported. */
  readonly nameServers?: string[];

  constructor(scope: Construct, id: string, props: DnsConstructProps) {
    super(scope, id);
    const { hostedZone } = props;

    if (hostedZone.mode === 'import') {
      if (!hostedZone.hostedZoneId) {
        throw new Error('DnsConstruct: hostedZoneId is required to import an existing zone.');
      }
      this.hostedZone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: hostedZone.hostedZoneId,
        zoneName: hostedZone.zoneName,
      });
    } else {
      const zone = new HostedZone(this, 'Zone', { zoneName: hostedZone.zoneName });
      this.hostedZone = zone;
      this.nameServers = zone.hostedZoneNameServers;
    }
  }
}
