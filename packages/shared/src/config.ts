/**
 * FreeMail deploy configuration — the single source of truth shared by the
 * `freemail init` CLI (which writes it) and the CDK app (which reads it at synth).
 *
 * `parseFreeMailConfig` is intentionally fail-loud: a malformed config is a
 * deploy-time footgun, so we reject it with a clear message rather than
 * silently defaulting.
 */

/** The only supported region — inbound SES + CloudFront ACM certs both require us-east-1. */
export const DEFAULT_REGION = 'us-east-1';

export type HostedZoneMode = 'import' | 'create';

export interface HostedZoneConfig {
  /** `import` an existing Route53 zone, or `create` a new one. */
  readonly mode: HostedZoneMode;
  /** The zone apex domain, e.g. `example.com`. */
  readonly zoneName: string;
  /** Required when `mode === 'import'`: the existing zone's ID. */
  readonly hostedZoneId?: string;
}

export interface InboundConfig {
  /** Receive email (SES receipt → S3). Off by default. */
  readonly enabled: boolean;
  /**
   * Explicit acknowledgement of the MX override that enabling inbound performs.
   * Enabling inbound points the email domain's MX at SES; this must be `true`
   * before inbound can be enabled (enforced here and independently at synth).
   */
  readonly confirmInboundMx: boolean;
}

export interface FreeMailConfig {
  /** AWS region. Pinned to us-east-1. */
  readonly region: string;
  readonly hostedZone: HostedZoneConfig;
  /** Domain email is sent from / received at — the zone apex or a subdomain of it. */
  readonly emailDomain: string;
  /**
   * Domain the web app is served at (CloudFront alias). REQUIRED (#47): the SPA calls
   * the API cross-origin, so this is the single canonical origin the API's credentialed
   * CORS allowlist is built from — there is no deployment shape without it.
   */
  readonly appDomain: string;
  /**
   * Domain the API is served at (API Gateway custom domain). REQUIRED (#47): the browser
   * and agents both reach the API here directly, and the session cookies are host-locked
   * to it.
   */
  readonly apiDomain: string;
  readonly inbound: InboundConfig;
}

/** Canonicalize a domain: trim, lowercase, drop a trailing dot (DNS is case-insensitive). */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** True when `domain` equals `parent` or is a subdomain of it. Both should be normalized first. */
export function isSubdomainOrEqual(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`FreeMail config: "${field}" must be a non-empty string.`);
  }
  return value;
}

function requireDomain(value: unknown, field: string): string {
  const normalized = normalizeDomain(requireNonEmptyString(value, field));
  if (normalized.length === 0) {
    throw new Error(`FreeMail config: "${field}" must be a valid domain.`);
  }
  return normalized;
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
 * any structural or semantic problem. Domains are canonicalized; `region`
 * defaults to (and must equal) us-east-1.
 */
export function parseFreeMailConfig(input: unknown): FreeMailConfig {
  if (!isRecord(input)) {
    throw new Error('FreeMail config: expected a JSON object.');
  }

  const region =
    input.region === undefined ? DEFAULT_REGION : requireNonEmptyString(input.region, 'region');
  if (region !== DEFAULT_REGION) {
    throw new Error(
      `FreeMail config: "region" must be ${DEFAULT_REGION} (the only supported region).`,
    );
  }

  if (!isRecord(input.hostedZone)) {
    throw new Error('FreeMail config: "hostedZone" must be an object.');
  }
  const mode = input.hostedZone.mode;
  if (mode !== 'import' && mode !== 'create') {
    throw new Error('FreeMail config: "hostedZone.mode" must be "import" or "create".');
  }
  const zoneName = requireDomain(input.hostedZone.zoneName, 'hostedZone.zoneName');
  let hostedZoneId: string | undefined;
  if (mode === 'import') {
    // Zone IDs are case-sensitive — do not normalize.
    hostedZoneId = requireNonEmptyString(
      input.hostedZone.hostedZoneId,
      'hostedZone.hostedZoneId',
    ).trim();
  } else if (input.hostedZone.hostedZoneId !== undefined) {
    throw new Error(
      'FreeMail config: "hostedZone.hostedZoneId" is only valid when mode is "import".',
    );
  }

  const emailDomain = requireDomain(input.emailDomain, 'emailDomain');
  if (!isSubdomainOrEqual(emailDomain, zoneName)) {
    throw new Error(
      `FreeMail config: "emailDomain" (${emailDomain}) must equal or be a subdomain of the hosted zone (${zoneName}).`,
    );
  }

  // Both custom domains are REQUIRED as of #47. The CloudFront `/api` proxy is gone, so
  // the browser calls the API cross-origin: the API needs one canonical app origin to
  // allowlist, and the SPA needs an absolute API URL. A deploy missing either has no
  // working web app, so it is rejected here rather than shipped half-configured.
  const appDomain = requireDomain(input.appDomain, 'appDomain');
  const apiDomain = requireDomain(input.apiDomain, 'apiDomain');
  // A custom domain's ACM validation records and CloudFront/API-GW alias records are
  // created inside the single managed hosted zone, so a domain outside it would
  // silently fail to validate/resolve — reject it at parse (same rule as emailDomain).
  if (!isSubdomainOrEqual(appDomain, zoneName)) {
    throw new Error(
      `FreeMail config: "appDomain" (${appDomain}) must equal or be a subdomain of the hosted zone (${zoneName}).`,
    );
  }
  if (!isSubdomainOrEqual(apiDomain, zoneName)) {
    throw new Error(
      `FreeMail config: "apiDomain" (${apiDomain}) must equal or be a subdomain of the hosted zone (${zoneName}).`,
    );
  }
  // The same host cannot be an alias for both the web app (CloudFront) and the API
  // (API Gateway) — the two alias records would collide. It would also collapse the
  // cross-origin boundary the #47 CORS model is built on.
  if (appDomain === apiDomain) {
    throw new Error(
      `FreeMail config: "appDomain" and "apiDomain" must be different domains (both are "${appDomain}").`,
    );
  }

  if (!isRecord(input.inbound)) {
    throw new Error('FreeMail config: "inbound" must be an object.');
  }
  const inbound: InboundConfig = {
    enabled: requireBoolean(input.inbound.enabled, 'inbound.enabled'),
    confirmInboundMx: requireBoolean(input.inbound.confirmInboundMx, 'inbound.confirmInboundMx'),
  };
  if (inbound.enabled && !inbound.confirmInboundMx) {
    throw new Error(
      'FreeMail config: inbound is enabled but "inbound.confirmInboundMx" is not true. ' +
        'Acknowledge the MX override before enabling inbound.',
    );
  }

  return {
    region,
    hostedZone: { mode, zoneName, ...(hostedZoneId ? { hostedZoneId } : {}) },
    emailDomain,
    appDomain,
    apiDomain,
    inbound,
  };
}
