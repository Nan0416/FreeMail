import { ListHostedZonesCommand, Route53Client } from '@aws-sdk/client-route-53';
import { DEFAULT_REGION } from '@freemail/shared';

export interface HostedZoneSummary {
  /** Zone apex domain, trailing dot stripped (e.g. `example.com`). */
  readonly name: string;
  /** Bare zone ID, `/hostedzone/` prefix stripped (e.g. `Z0123ABC`). */
  readonly id: string;
}

/**
 * List the account's public Route53 hosted zones so `freemail init` can offer a
 * pick-from-list instead of asking the deployer to paste a zone ID. Route53 is a
 * global service; the region only satisfies the SDK client.
 */
export async function listHostedZones(): Promise<HostedZoneSummary[]> {
  const client = new Route53Client({ region: DEFAULT_REGION });
  const zones: HostedZoneSummary[] = [];
  let marker: string | undefined;

  do {
    const response = await client.send(new ListHostedZonesCommand({ Marker: marker }));
    for (const zone of response.HostedZones ?? []) {
      if (zone.Config?.PrivateZone) {
        continue; // private zones can't serve public email / DNS-auth records
      }
      const name = (zone.Name ?? '').replace(/\.$/, '');
      const id = (zone.Id ?? '').replace(/^\/hostedzone\//, '');
      if (name && id) {
        zones.push({ name, id });
      }
    }
    marker = response.IsTruncated ? response.NextMarker : undefined;
  } while (marker);

  return zones;
}
