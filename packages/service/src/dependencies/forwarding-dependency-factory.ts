/**
 * Collaborators for the forwarder Lambda, built once per cold start from {@link ForwardingConfig}.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import { DdbForwardingRulesDao } from '../data/ddb-forwarding-rules-dao.js';
import { createDocumentClient } from '../data/document-client.js';
import type { EmailsDao } from '../data/emails-dao.js';
import type { ForwardingRulesDao } from '../data/forwarding-rules-dao.js';
import { S3RawMessageReader } from '../facades/s3-raw-message-reader.js';
import { SesV2Sender } from '../facades/ses-email-facade.js';
import type { ForwardingConfig } from '../handlers/forwarding-config.js';
import { ForwardingProcessor } from '../processors/forwarding-processor.js';

export interface ForwardingDependencies {
  readonly emailsDao: EmailsDao;
  readonly forwardingRulesDao: ForwardingRulesDao;
  readonly processor: ForwardingProcessor;
}

export class ForwardingDependencyFactory {
  private readonly config: ForwardingConfig;

  constructor(config: ForwardingConfig) {
    this.config = config;
  }

  build(): ForwardingDependencies {
    const doc = createDocumentClient();
    const emailsDao = new DdbEmailsDao(doc, this.config.emailsTable);
    const forwardingRulesDao = new DdbForwardingRulesDao(doc, this.config.forwardingRulesTable);
    return {
      emailsDao,
      forwardingRulesDao,
      processor: new ForwardingProcessor({
        emails: emailsDao,
        rules: forwardingRulesDao,
        rawMessages: new S3RawMessageReader(new S3Client({}), this.config.mailBucket),
        ses: new SesV2Sender({
          client: new SESv2Client({}),
          configurationSetName: this.config.sesConfigurationSet,
        }),
        emailDomain: this.config.emailDomain,
      }),
    };
  }
}
