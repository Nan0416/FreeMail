/**
 * The authorizer Lambda's environment contract.
 *
 * Both tables are READ-ONLY here — the authorizer holds no write grant on either. It looks
 * up hashed API keys to validate a presented one, and reads (never creates) the HS256
 * signing key: a token presented against a table with no key cannot be one this deployment
 * issued, so failing closed is correct. Key generation belongs to the REST handler, which
 * is the only component with the write grant.
 *
 * Following conduit, the authorizer gets a config but no dependency factory — it wires its
 * two collaborators inline, because there is no service layer over them.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

export interface AuthorizerConfig {
  readonly authTable: string;
  readonly apiKeysTable: string;
}

const ENV_SCHEMA = z.object({
  AUTH_TABLE: envString(),
  API_KEYS_TABLE: envString(),
});

export function getAuthorizerConfig(env: NodeJS.ProcessEnv = process.env): AuthorizerConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'authorizer', env);
  return { authTable: parsed.AUTH_TABLE, apiKeysTable: parsed.API_KEYS_TABLE };
}
