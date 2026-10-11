/**
 * Collaborators for the SES-events Lambda, built once per cold start from {@link SesEventsConfig}.
 */
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import { createDocumentClient } from '../data/document-client.js';
import type { EmailsDao } from '../data/emails-dao.js';
import type { SesEventsConfig } from '../handlers/ses-events-config.js';
import { SesEventProcessor } from '../processors/ses-event-processor.js';

export interface SesEventsDependencies {
  readonly emailsDao: EmailsDao;
  readonly processor: SesEventProcessor;
}

export class SesEventsDependencyFactory {
  private readonly config: SesEventsConfig;

  constructor(config: SesEventsConfig) {
    this.config = config;
  }

  build(): SesEventsDependencies {
    const emailsDao = new DdbEmailsDao(createDocumentClient(), this.config.emailsTable);
    return { emailsDao, processor: new SesEventProcessor(emailsDao) };
  }
}
