/**
 * Collaborators for the MCP Lambda, built once per cold start from {@link McpConfig}.
 *
 * The read service is built ONLY when inbound is enabled. That is not an optimization: with
 * inbound off, the Lambda holds no read grants on the emails table or the inbound S3
 * prefixes, so constructing a reader would produce an object whose every call is a denied
 * request. Absent is the honest representation, and `buildMcpServer` advertises the read
 * tools only when it is present.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DdbDownloadTokensDao } from '../data/ddb-download-tokens-dao.js';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import { createDocumentClient } from '../data/document-client.js';
import { S3InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import { S3OutboundObjectStore } from '../facades/s3-outbound-object-store.js';
import { S3AttachmentPresigner } from '../facades/s3-attachment-presigner.js';
import { EmailReadService } from '../services/email-read-service.js';
import { EmailService } from '../services/email-service.js';
import { SesV2Sender } from '../facades/ses-email-facade.js';
import type { McpConfig } from '../handlers/mcp-config.js';

export interface McpDependencies {
  readonly emailService: EmailService;
  /** Present only when inbound is enabled — see the note above. */
  readonly readService: EmailReadService | undefined;
  readonly inboundEnabled: boolean;
}

export class McpDependencyFactory {
  private readonly config: McpConfig;

  constructor(config: McpConfig) {
    this.config = config;
  }

  build(): McpDependencies {
    const doc = createDocumentClient();
    const s3 = new S3Client({});

    const emailsDao = new DdbEmailsDao(doc, this.config.emailsTable);
    const downloadTokensDao = new DdbDownloadTokensDao(doc, this.config.downloadTokensTable);

    const emailService = new EmailService({
      ses: new SesV2Sender({
        client: new SESv2Client({}),
        configurationSetName: this.config.sesConfigurationSet,
      }),
      emailsDao,
      objectStore: new S3OutboundObjectStore(s3, this.config.mailBucket),
      tokensDao: downloadTokensDao,
      downloadBaseUrl: this.config.downloadBaseUrl,
      emailDomain: this.config.emailDomain,
    });

    if (!this.config.inboundEnabled) {
      return { emailService, readService: undefined, inboundEnabled: false };
    }

    return {
      emailService,
      readService: new EmailReadService({
        emailsDao,
        presigner: new S3AttachmentPresigner(s3, this.config.mailBucket),
        rawMime: new S3InboundObjectStore(s3, this.config.mailBucket),
      }),
      inboundEnabled: true,
    };
  }
}
