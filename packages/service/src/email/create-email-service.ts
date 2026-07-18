/**
 * Constructs an {@link EmailService} from the Lambda environment. The DDB repos, SES
 * client, and S3 store are cached in module scope so they're reused across warm
 * invocations. Shared by every entry point that sends (the REST `/emails` route and the
 * MCP `send_email` tool) so the repo/SES/large-attachment wiring lives in ONE place.
 */
import { DdbDownloadTokensRepo } from '../data/ddb-download-tokens-repo.js';
import { DdbEmailsRepo } from '../data/ddb-emails-repo.js';
import { S3OutboundAttachmentStore } from '../data/outbound-attachment-store.js';
import { EmailService } from './service.js';
import { SesV2Sender } from './ses-sender.js';

let emailsRepo: DdbEmailsRepo | undefined;
let sesSender: SesV2Sender | undefined;
let objectStore: S3OutboundAttachmentStore | undefined;
let tokensRepo: DdbDownloadTokensRepo | undefined;

export function createEmailServiceFromEnv(): EmailService {
  const emailDomain = process.env.EMAIL_DOMAIN;
  if (!emailDomain) {
    throw new Error('EMAIL_DOMAIN is not set.');
  }
  const tableName = process.env.EMAILS_TABLE;
  if (!tableName) {
    throw new Error('EMAILS_TABLE is not set.');
  }
  // Large-attachment (#14) wiring — required for both REST and MCP send.
  const mailBucket = process.env.MAIL_BUCKET;
  if (!mailBucket) {
    throw new Error('MAIL_BUCKET is not set.');
  }
  const downloadTokensTable = process.env.DOWNLOAD_TOKENS_TABLE;
  if (!downloadTokensTable) {
    throw new Error('DOWNLOAD_TOKENS_TABLE is not set.');
  }
  const downloadBaseUrl = process.env.DOWNLOAD_BASE_URL;
  if (!downloadBaseUrl) {
    throw new Error('DOWNLOAD_BASE_URL is not set.');
  }
  emailsRepo ??= new DdbEmailsRepo(tableName);
  sesSender ??= new SesV2Sender({ configurationSetName: process.env.SES_CONFIGURATION_SET });
  objectStore ??= new S3OutboundAttachmentStore(mailBucket);
  tokensRepo ??= new DdbDownloadTokensRepo(downloadTokensTable);
  return new EmailService({
    ses: sesSender,
    emails: emailsRepo,
    objectStore,
    tokens: tokensRepo,
    downloadBaseUrl,
    emailDomain,
  });
}
