/**
 * The forwarder Lambda's environment contract: it reads the forwarding rules, a received
 * message's row and raw MIME, sends the forwarded copy through SES (under the configuration set, so suppression and
 * bounce/complaint tracking apply), and records the forward on the row.
 */
import { z } from 'zod';
import { envString, parseEnv } from '../utils/env-config.js';

export interface ForwardingConfig {
  readonly emailsTable: string;
  /** The rules, edited in the web app; read on every received message. */
  readonly forwardingRulesTable: string;
  /** Where SES stores raw inbound MIME. */
  readonly mailBucket: string;
  /** The deployment's email domain: the forwarding address's, and never a forward target. */
  readonly emailDomain: string;
  readonly sesConfigurationSet: string;
}

const ENV_SCHEMA = z.object({
  EMAILS_TABLE: envString(),
  FORWARDING_RULES_TABLE: envString(),
  MAIL_BUCKET: envString(),
  EMAIL_DOMAIN: envString(),
  SES_CONFIGURATION_SET: envString(),
});

export function getForwardingConfig(env: NodeJS.ProcessEnv = process.env): ForwardingConfig {
  const parsed = parseEnv(ENV_SCHEMA, 'forwarding handler', env);
  return {
    emailsTable: parsed.EMAILS_TABLE,
    forwardingRulesTable: parsed.FORWARDING_RULES_TABLE,
    mailBucket: parsed.MAIL_BUCKET,
    emailDomain: parsed.EMAIL_DOMAIN,
    sesConfigurationSet: parsed.SES_CONFIGURATION_SET,
  };
}
