/**
 * Collaborators for the inbound-parser Lambda, built once per cold start from
 * {@link InboundConfig}.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import { createDocumentClient } from '../data/document-client.js';
import type { EmailsDao } from '../data/emails-dao.js';
import { S3InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import { S3MailBodyStore } from '../facades/s3-mail-body-store.js';
import { S3QuarantineStore } from '../facades/s3-quarantine-store.js';
import type { InboundConfig } from '../handlers/inbound-config.js';
import { InboundProcessor } from '../services/inbound-service.js';

export interface InboundDependencies {
  readonly emailsDao: EmailsDao;
  readonly objectStore: S3InboundObjectStore;
  readonly processor: InboundProcessor;
}

export class InboundDependencyFactory {
  private readonly config: InboundConfig;

  constructor(config: InboundConfig) {
    this.config = config;
  }

  build(): InboundDependencies {
    const s3 = new S3Client({});
    const emailsDao = new DdbEmailsDao(createDocumentClient(), this.config.emailsTable);
    const objectStore = new S3InboundObjectStore(s3, this.config.mailBucket);
    return {
      emailsDao,
      objectStore,
      processor: new InboundProcessor(
        objectStore,
        emailsDao,
        new S3MailBodyStore(s3, this.config.mailBucket),
        new S3QuarantineStore(s3, this.config.mailBucket, this.config.quarantineBucket),
      ),
    };
  }
}
