/**
 * Inbound-mail parser Lambda. Triggered by S3 `ObjectCreated` on the `inbound/`
 * prefix (see the infra construct) — one raw MIME object per record. All the work is
 * in {@link InboundProcessor.processInboundEmail}; this file is the entry point + a bounded diagnostic
 * log. A handled failure (bad key / oversize / malformed / over-limit) is logged and
 * returns normally; only an infra error propagates, so the async invocation retries
 * and eventually DLQs.
 */
import type { S3Event } from 'aws-lambda';
import { InboundDependencyFactory, type InboundDependencies } from '../dependencies/index.js';
import { getLogger } from '../utils/logger.js';
import { getInboundConfig } from './inbound-config.js';

const logger = getLogger('inbound-lambda');

/** Cap logged keys so an adversarial key can't bloat the logs. */
const MAX_LOGGED_KEY = 256;

let deps: InboundDependencies | undefined;

function init(): InboundDependencies {
  if (deps) {
    logger.debug('Reusing lambda instance.');
    return deps;
  }
  logger.info('Creating new inbound handler instance.');
  deps = new InboundDependencyFactory(getInboundConfig()).build();
  return deps;
}

export const handler = async (event: S3Event): Promise<void> => {
  const instance = init();
  for (const record of event.Records) {
    const rawKey = record.s3.object.key;
    const result = await instance.processor.processInboundEmail({ rawKey });
    console.log(
      JSON.stringify({
        msg: 'inbound.processed',
        key: rawKey.slice(0, MAX_LOGGED_KEY),
        outcome: result.outcome,
        messageId: result.messageId,
        reason: result.reason,
      }),
    );
  }
};
