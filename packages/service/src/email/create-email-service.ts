/**
 * Constructs an {@link EmailService} from the Lambda environment. The DDB repo and
 * SES client are cached in module scope so they're reused across warm invocations.
 * Shared by every entry point that sends (the REST `/emails` route and the MCP
 * `send_email` tool) so the repo/SES wiring lives in ONE place.
 */
import { DdbEmailsRepo } from '../data/ddb-emails-repo.js';
import { EmailService } from './service.js';
import { SesV2Sender } from './ses-sender.js';

let emailsRepo: DdbEmailsRepo | undefined;
let sesSender: SesV2Sender | undefined;

export function createEmailServiceFromEnv(): EmailService {
  const emailDomain = process.env.EMAIL_DOMAIN;
  if (!emailDomain) {
    throw new Error('EMAIL_DOMAIN is not set.');
  }
  const tableName = process.env.EMAILS_TABLE;
  if (!tableName) {
    throw new Error('EMAILS_TABLE is not set.');
  }
  emailsRepo ??= new DdbEmailsRepo(tableName);
  sesSender ??= new SesV2Sender({ configurationSetName: process.env.SES_CONFIGURATION_SET });
  return new EmailService({ ses: sesSender, emails: emailsRepo, emailDomain });
}
