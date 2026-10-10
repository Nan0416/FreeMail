/**
 * The inbound-parser Lambda's environment contract — the narrowest of the four. It reads
 * raw MIME from S3, writes metadata to the emails table, and copies the raw MIME of a message
 * whose content can't be extracted into the quarantine bucket — and touches nothing else.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

export interface InboundConfig {
  readonly emailsTable: string;
  readonly mailBucket: string;
  /** Raw MIME of Errors-folder messages (failed scan or parse), kept for download. */
  readonly quarantineBucket: string;
}

const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
  MAIL_BUCKET: envString(),
  QUARANTINE_BUCKET: envString(),
});

export function getInboundConfig(env: NodeJS.ProcessEnv = process.env): InboundConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'inbound handler', env);
  return {
    emailsTable: parsed.EMAILS_TABLE,
    mailBucket: parsed.MAIL_BUCKET,
    quarantineBucket: parsed.QUARANTINE_BUCKET,
  };
}
