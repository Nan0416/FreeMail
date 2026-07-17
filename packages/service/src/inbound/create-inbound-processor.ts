/**
 * Constructs an {@link InboundProcessor} from the Lambda environment. The S3 store
 * and DDB repo are cached in module scope so they're reused across warm invocations.
 */
import { DdbEmailsRepo } from '../data/ddb-emails-repo.js';
import { S3InboundObjectStore } from '../data/inbound-object-store.js';
import { InboundProcessor } from './processor.js';

let processor: InboundProcessor | undefined;

export function createInboundProcessorFromEnv(): InboundProcessor {
  const tableName = process.env.EMAILS_TABLE;
  if (!tableName) {
    throw new Error('EMAILS_TABLE is not set.');
  }
  const bucket = process.env.MAIL_BUCKET;
  if (!bucket) {
    throw new Error('MAIL_BUCKET is not set.');
  }
  processor ??= new InboundProcessor(
    new S3InboundObjectStore(bucket),
    new DdbEmailsRepo(tableName),
  );
  return processor;
}
