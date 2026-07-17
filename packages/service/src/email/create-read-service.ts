/**
 * Constructs an {@link EmailReadService} from the Lambda environment, caching the repo,
 * presigner, and raw-MIME store in module scope so they're reused across warm invocations.
 * Mirrors {@link ./create-email-service.createEmailServiceFromEnv} — the read routes and
 * (later) #13's MCP read tools build the service through this one place.
 */
import { DdbEmailsRepo } from '../data/ddb-emails-repo.js';
import { S3AttachmentPresigner } from '../data/s3-attachment-presigner.js';
import { S3InboundObjectStore } from '../data/inbound-object-store.js';
import { EmailReadService } from './read-service.js';

let emailsRepo: DdbEmailsRepo | undefined;
let presigner: S3AttachmentPresigner | undefined;
let rawStore: S3InboundObjectStore | undefined;

export function createEmailReadServiceFromEnv(): EmailReadService {
  const tableName = process.env.EMAILS_TABLE;
  if (!tableName) {
    throw new Error('EMAILS_TABLE is not set.');
  }
  const mailBucket = process.env.MAIL_BUCKET;
  if (!mailBucket) {
    throw new Error('MAIL_BUCKET is not set.');
  }
  emailsRepo ??= new DdbEmailsRepo(tableName);
  presigner ??= new S3AttachmentPresigner(mailBucket);
  rawStore ??= new S3InboundObjectStore(mailBucket);
  return new EmailReadService({ emails: emailsRepo, presigner, rawMime: rawStore });
}
