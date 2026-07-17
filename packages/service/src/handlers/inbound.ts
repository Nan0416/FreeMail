/**
 * Inbound-mail parser Lambda. Triggered by S3 `ObjectCreated` on the `inbound/`
 * prefix (see the infra construct) — one raw MIME object per record. All the work is
 * in {@link InboundProcessor.process}; this file is env wiring + a bounded diagnostic
 * log. A handled failure (bad key / oversize / malformed / over-limit) is logged and
 * returns normally; only an infra error propagates, so the async invocation retries
 * and eventually DLQs.
 */
import type { S3Event } from 'aws-lambda';
import { createInboundProcessorFromEnv } from '../inbound/create-inbound-processor.js';

/** Cap logged keys so an adversarial key can't bloat the logs. */
const MAX_LOGGED_KEY = 256;

export const handler = async (event: S3Event): Promise<void> => {
  const processor = createInboundProcessorFromEnv();
  for (const record of event.Records) {
    const rawKey = record.s3.object.key;
    const result = await processor.process(rawKey);
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
