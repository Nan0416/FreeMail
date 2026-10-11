/**
 * SES delivery-report Lambda. Subscribed to the configuration set's SNS topic — one SES event
 * per record. All the work is in {@link SesEventProcessor.processSesEvent}; this file is the
 * entry point plus one bounded log line per report. A report it cannot place is logged and
 * skipped; only a storage failure throws, so the async invocation retries.
 */
import type { SNSEvent } from 'aws-lambda';
import { SesEventsDependencyFactory, type SesEventsDependencies } from '../dependencies/index.js';
import { getLogger } from '../utils/logger.js';
import { getSesEventsConfig } from './ses-events-config.js';

const logger = getLogger('ses-events-lambda');

let deps: SesEventsDependencies | undefined;

function init(): SesEventsDependencies {
  if (deps) {
    logger.debug('Reusing lambda instance.');
    return deps;
  }
  logger.info('Creating new SES events handler instance.');
  deps = new SesEventsDependencyFactory(getSesEventsConfig()).build();
  return deps;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const instance = init();
  for (const record of event.Records) {
    const result = await instance.processor.processSesEvent({ message: record.Sns.Message });
    console.log(
      JSON.stringify({
        msg: 'ses-event.processed',
        outcome: result.outcome,
        emailId: result.emailId,
        reason: result.reason,
      }),
    );
  }
};
