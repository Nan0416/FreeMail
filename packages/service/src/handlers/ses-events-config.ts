/**
 * The SES-events Lambda's environment contract: it only appends delivery reports to the sent
 * messages' rows, so it needs the emails table and nothing else.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

export interface SesEventsConfig {
  readonly emailsTable: string;
}

const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
});

export function getSesEventsConfig(env: NodeJS.ProcessEnv = process.env): SesEventsConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'SES events handler', env);
  return { emailsTable: parsed.EMAILS_TABLE };
}
