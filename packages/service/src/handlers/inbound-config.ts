/**
 * The inbound-parser Lambda's environment contract — the narrowest of the four. It reads
 * raw MIME from S3 and writes metadata to the emails table, and touches nothing else.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

export interface InboundConfig {
  readonly emailsTable: string;
  readonly mailBucket: string;
}

const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
  MAIL_BUCKET: envString(),
});

export function getInboundConfig(env: NodeJS.ProcessEnv = process.env): InboundConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'inbound handler', env);
  return { emailsTable: parsed.EMAILS_TABLE, mailBucket: parsed.MAIL_BUCKET };
}
