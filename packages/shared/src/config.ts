/**
 * FreeMail deploy configuration — the single source of truth shared by the
 * `freemail init` CLI (which writes it) and the CDK app (which reads it at synth).
 *
 * `parseFreeMailConfig` is intentionally fail-loud: a malformed config is a
 * deploy-time footgun, so we reject it with a clear message rather than
 * silently defaulting.
 */

/** Default (and only supported) region — inbound SES + CloudFront ACM certs both require us-east-1. */
export const DEFAULT_REGION = 'us-east-1';

export type HostedZoneMode = 'import' | 'create';

export interface HostedZoneConfig {
  /** `import` an existing Route53 zone, or `create` a new one. */
  mode: HostedZoneMode;
  /** The zone apex domain, e.g. `example.com`. */
  zoneName: string;
  /** Required when `mode === 'import'`: the existing zone's ID. */
  hostedZoneId?: string;
}

export interface InboundConfig {
  /** Receive email (SES receipt → S3). Off by default. */
  enabled: boolean;
  /**
   * Explicit acknowledgement of the MX override that enabling inbound performs.
   * Enabling inbound points the email domain's MX at SES; this flag must be
   * `true` before inbound can be deployed (enforced at synth).
   */
  confirmInboundMx: boolean;
}

export interface FreeMailConfig {
  /** AWS region. Pinned to us-east-1. */
  region: string;
  hostedZone: HostedZoneConfig;
  /** Domain email is sent from / received at — the zone apex or a subdomain of it. */
  emailDomain: string;
  /** Custom domain for the web app. Omit to use the CloudFront default domain. */
  appDomain?: string;
  /** Custom domain for the API. Omit to use the API Gateway default domain. */
  apiDomain?: string;
  inbound: InboundConfig;
}

/** True when `domain` equals `parent` or is a subdomain of it. */
export function isSubdomainOrEqual(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`FreeMail config: "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`FreeMail config: "${field}" must be a boolean.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize an unknown value into a `FreeMailConfig`, throwing on
 * any structural or semantic problem. `region` defaults to us-east-1 when absent.
 */
export function parseFreeMailConfig(input: unknown): FreeMailConfig {
  if (!isRecord(input)) {
    throw new Error('FreeMail config: expected a JSON object.');
  }

  const region =
    input.region === undefined ? DEFAULT_REGION : requireNonEmptyString(input.region, 'region');

  if (!isRecord(input.hostedZone)) {
    throw new Error('FreeMail config: "hostedZone" must be an object.');
  }
  const mode = input.hostedZone.mode;
  if (mode !== 'import' && mode !== 'create') {
    throw new Error('FreeMail config: "hostedZone.mode" must be "import" or "create".');
  }
  const zoneName = requireNonEmptyString(input.hostedZone.zoneName, 'hostedZone.zoneName');
  let hostedZoneId: string | undefined;
  if (mode === 'import') {
    hostedZoneId = requireNonEmptyString(input.hostedZone.hostedZoneId, 'hostedZone.hostedZoneId');
  } else if (input.hostedZone.hostedZoneId !== undefined) {
    throw new Error(
      'FreeMail config: "hostedZone.hostedZoneId" is only valid when mode is "import".',
    );
  }

  const emailDomain = requireNonEmptyString(input.emailDomain, 'emailDomain');
  if (!isSubdomainOrEqual(emailDomain, zoneName)) {
    throw new Error(
      `FreeMail config: "emailDomain" (${emailDomain}) must equal or be a subdomain of the hosted zone (${zoneName}).`,
    );
  }

  const appDomain =
    input.appDomain === undefined ? undefined : requireNonEmptyString(input.appDomain, 'appDomain');
  const apiDomain =
    input.apiDomain === undefined ? undefined : requireNonEmptyString(input.apiDomain, 'apiDomain');

  if (!isRecord(input.inbound)) {
    throw new Error('FreeMail config: "inbound" must be an object.');
  }
  const inbound: InboundConfig = {
    enabled: requireBoolean(input.inbound.enabled, 'inbound.enabled'),
    confirmInboundMx: requireBoolean(input.inbound.confirmInboundMx, 'inbound.confirmInboundMx'),
  };

  return {
    region,
    hostedZone: { mode, zoneName, ...(hostedZoneId ? { hostedZoneId } : {}) },
    emailDomain,
    ...(appDomain ? { appDomain } : {}),
    ...(apiDomain ? { apiDomain } : {}),
    inbound,
  };
}
