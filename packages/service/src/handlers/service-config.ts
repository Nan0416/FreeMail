/**
 * The REST Lambda's environment contract, read and validated ONCE per cold start.
 *
 * Every value here is baked in by CDK (`ApiConstruct`'s `RestHandler` environment), so a
 * missing one is a deploy bug, not a runtime condition.
 *
 * Conduit keeps its main service's config at the package root as `stage-config.ts` while
 * every secondary Lambda gets a `handlers/<name>-config.ts`. FreeMail deliberately does not
 * copy that: `service-handler.ts` is a Lambda like any other, so its config sits beside it
 * under the same `<name>-config.ts` naming as `mcp-config.ts`, `inbound-config.ts` and
 * `authorizer-config.ts` — one rule for all four, rather than three plus an exception.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

/** Validated, camel-cased view of the REST Lambda's environment. */
export interface ServiceConfig {
  /** Password hash + rotating refresh tokens + lockout counters + the HS256 signing key. */
  readonly authTable: string;
  /** Hashed agent API keys, managed by the `/keys` routes. */
  readonly apiKeysTable: string;
  /** Sent + inbound email metadata. */
  readonly emailsTable: string;
  /** Outbound large-attachment download tokens (#14). */
  readonly downloadTokensTable: string;
  /** Inbound raw MIME, extracted attachments, and outbound large attachments. */
  readonly mailBucket: string;
  /** Raw MIME of Errors-folder messages — the read routes presign their `.eml` downloads. */
  readonly quarantineBucket: string;
  /** The SES send domain — every `from` must be under it. */
  readonly emailDomain: string;
  /** Public base for `/d/{token}` links (the API's own endpoint; never the bucket). */
  readonly downloadBaseUrl: string;
  /** SES configuration set for suppression + bounce/complaint tracking. Optional. */
  readonly sesConfigurationSet: string | undefined;
}

const ENV_SCHEMA = z.object({
  AUTH_TABLE: envString(),
  API_KEYS_TABLE: envString(),
  EMAILS_TABLE: envString(),
  DOWNLOAD_TOKENS_TABLE: envString(),
  MAIL_BUCKET: envString(),
  QUARANTINE_BUCKET: envString(),
  EMAIL_DOMAIN: envString(),
  DOWNLOAD_BASE_URL: envString(),
  SES_CONFIGURATION_SET: envString().optional(),
});

let cached: ServiceConfig | undefined;

/**
 * The validated config for this execution environment, computed on first use and reused for
 * the life of the container (the environment cannot change under a running Lambda).
 */
export function getServiceConfig(): ServiceConfig {
  cached ??= readServiceConfig();
  return cached;
}

/** Test seam / cold-start reset — drops the memoized config. */
export function resetServiceConfigCache(): void {
  cached = undefined;
}

/** Read and validate an environment without memoizing. */
export function readServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'REST handler', env);
  return {
    authTable: parsed.AUTH_TABLE,
    apiKeysTable: parsed.API_KEYS_TABLE,
    emailsTable: parsed.EMAILS_TABLE,
    downloadTokensTable: parsed.DOWNLOAD_TOKENS_TABLE,
    mailBucket: parsed.MAIL_BUCKET,
    quarantineBucket: parsed.QUARANTINE_BUCKET,
    emailDomain: parsed.EMAIL_DOMAIN,
    downloadBaseUrl: parsed.DOWNLOAD_BASE_URL,
    sesConfigurationSet: parsed.SES_CONFIGURATION_SET,
  };
}
