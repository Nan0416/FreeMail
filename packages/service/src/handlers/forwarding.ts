/**
 * Forwarder Lambda. Reads the forwarder queue, which the email-received topic fills (spam
 * filtered out by the subscription, delivered raw, so each body is one notification). All the
 * work is in {@link ForwardingProcessor.forwardReceivedEmail}; this file is the entry point plus
 * one bounded log line per message. A message it does not forward is logged and skipped. An
 * infra failure is reported as that record's failure, so the queue redelivers it and, after
 * repeated failures, dead-letters it; the other records in the batch are done.
 */
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { ForwardingDependencyFactory, type ForwardingDependencies } from '../dependencies/index.js';
import { getLogger } from '../utils/logger.js';
import { getForwardingConfig } from './forwarding-config.js';

const logger = getLogger('forwarding-lambda');

let deps: ForwardingDependencies | undefined;

function init(): ForwardingDependencies {
  if (deps) {
    logger.debug('Reusing lambda instance.');
    return deps;
  }
  logger.info('Creating new forwarding handler instance.');
  deps = new ForwardingDependencyFactory(getForwardingConfig()).build();
  return deps;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const instance = init();
  const batchItemFailures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      const result = await instance.processor.forwardReceivedEmail({ message: record.body });
      console.log(
        JSON.stringify({
          msg: 'forwarding.processed',
          outcome: result.outcome,
          messageId: result.messageId,
          reason: result.reason,
          ruleIds: result.ruleIds,
          recipientCount: result.recipientCount,
        }),
      );
    } catch (err) {
      logger.error(`Forwarding failed for queue message ${record.messageId} ` + `(receive ${record.attributes.ApproximateReceiveCount}); it will be retried.`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
