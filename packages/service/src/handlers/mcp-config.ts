/**
 * The MCP Lambda's environment contract. Deliberately NARROWER than the REST handler's
 * {@link ServiceConfig}: the MCP function is given no `AUTH_TABLE` and no `API_KEYS_TABLE`,
 * because authentication is the Lambda authorizer's job and an agent must never reach key
 * management. One config type could not describe both Lambdas without being wrong for one.
 */
import { z } from 'zod';
import { envPositiveInt, envString, parseEnv } from '../utils/env-config.js';

export interface McpConfig {
  readonly emailsTable: string;
  readonly downloadTokensTable: string;
  readonly mailBucket: string;
  readonly emailDomain: string;
  readonly downloadBaseUrl: string;
  readonly sesConfigurationSet: string | undefined;
  /** Embed an attachment at most this size (bytes); undefined → the default. */
  readonly embedMaxBytes: number | undefined;
  /** Cap on one message's embedded attachments (bytes); undefined → the default. */
  readonly embedTotalBytes: number | undefined;
  /**
   * Gates the read tools (#13). Fail-closed: only the exact string `'true'` enables them,
   * so a typo'd or absent value leaves the mailbox unreadable rather than exposed.
   */
  readonly inboundEnabled: boolean;
}

const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
  DOWNLOAD_TOKENS_TABLE: envString(),
  MAIL_BUCKET: envString(),
  EMAIL_DOMAIN: envString(),
  DOWNLOAD_BASE_URL: envString(),
  SES_CONFIGURATION_SET: envString().optional(),
  EMBED_MAX_BYTES: envPositiveInt().optional(),
  EMBED_TOTAL_BYTES: envPositiveInt().optional(),
  INBOUND_ENABLED: envString().optional(),
});

export function getMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'MCP handler', env);
  return {
    emailsTable: parsed.EMAILS_TABLE,
    downloadTokensTable: parsed.DOWNLOAD_TOKENS_TABLE,
    mailBucket: parsed.MAIL_BUCKET,
    emailDomain: parsed.EMAIL_DOMAIN,
    downloadBaseUrl: parsed.DOWNLOAD_BASE_URL,
    sesConfigurationSet: parsed.SES_CONFIGURATION_SET,
    embedMaxBytes: parsed.EMBED_MAX_BYTES,
    embedTotalBytes: parsed.EMBED_TOTAL_BYTES,
    inboundEnabled: parsed.INBOUND_ENABLED === 'true',
  };
}
