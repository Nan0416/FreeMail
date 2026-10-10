/**
 * Builds every collaborator the REST Lambda needs, once per cold start, from the validated
 * {@link ServiceConfig}.
 *
 * Layered the way conduit's `DependencyFactory` is — AWS clients, then repos, then services
 * — and eagerly: `build()` is synchronous and returns finished objects, with no lazy hatch
 * and no `process.env` read below this line. The routes receive what they need through
 * their constructors, so "what does the send route actually talk to?" has exactly one
 * answer, and a route is testable with a fake.
 *
 * ONE client of each kind is created here and shared by every repo that needs it. That is
 * the reason the repos take a client rather than a table name alone: an SDK client owns a
 * connection pool, and letting four repos each construct their own would quietly create
 * four.
 *
 * Repos are exposed alongside the services (again following conduit) because they are the
 * useful seam for anything that needs storage without the policy on top of it.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { AuthService } from '../services/auth-service.js';
import { DdbSigningKeyProvider } from '../facades/signing-key-provider.js';
import type { SigningKeyProvider } from '../facades/signing-key-provider.js';
import type { AuthDao } from '../data/auth-dao.js';
import { DdbAuthDao } from '../data/ddb-auth-dao.js';
import { DdbDownloadTokensDao } from '../data/ddb-download-tokens-dao.js';
import { DdbEmailsDao } from '../data/ddb-emails-dao.js';
import { DdbApiKeysDao } from '../data/ddb-api-keys-dao.js';
import { createDocumentClient } from '../data/document-client.js';
import type { DownloadTokensDao } from '../data/download-tokens-dao.js';
import type { EmailsDao } from '../data/emails-dao.js';
import { S3InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import type { ApiKeysDao } from '../data/api-keys-dao.js';
import { S3MailBodyStore } from '../facades/s3-mail-body-store.js';
import { S3OutboundObjectStore } from '../facades/s3-outbound-object-store.js';
import { S3UploadStore } from '../facades/s3-upload-store.js';
import { AttachmentUploadService } from '../services/attachment-upload-service.js';
import { createUploadPresignClient, embedLimits } from './uploads.js';
import { S3AttachmentPresigner } from '../facades/s3-attachment-presigner.js';
import { DownloadService } from '../services/download-service.js';
import { EmailReadService } from '../services/email-read-service.js';
import { EmailService } from '../services/email-service.js';
import { SesV2Sender } from '../facades/ses-email-facade.js';
import { ApiKeyService } from '../services/api-key-service.js';
import type { ServiceConfig } from '../handlers/service-config.js';

export interface Dependencies {
  readonly authDao: AuthDao;
  readonly apiKeysDao: ApiKeysDao;
  readonly emailsDao: EmailsDao;
  readonly downloadTokensDao: DownloadTokensDao;
  readonly signingKeyProvider: SigningKeyProvider;
  readonly authService: AuthService;
  readonly apiKeyService: ApiKeyService;
  readonly emailService: EmailService;
  readonly emailReadService: EmailReadService;
  readonly downloadService: DownloadService;
  readonly attachmentUploadService: AttachmentUploadService;
}

export class DependencyFactory {
  private readonly config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  build(): Dependencies {
    const doc = createDocumentClient();
    const s3 = new S3Client({});

    const authDao = new DdbAuthDao(doc, this.config.authTable);
    const apiKeysDao = new DdbApiKeysDao(doc, this.config.apiKeysTable);
    const emailsDao = new DdbEmailsDao(doc, this.config.emailsTable);
    const downloadTokensDao = new DdbDownloadTokensDao(doc, this.config.downloadTokensTable);

    const presigner = new S3AttachmentPresigner(s3, this.config.mailBucket);
    const quarantinePresigner = new S3AttachmentPresigner(s3, this.config.quarantineBucket);
    const inboundStore = new S3InboundObjectStore(s3, this.config.mailBucket);
    const outboundStore = new S3OutboundObjectStore(s3, this.config.mailBucket);
    const bodyStore = new S3MailBodyStore(s3, this.config.mailBucket);
    const uploadStore = new S3UploadStore(s3, createUploadPresignClient(), this.config.mailBucket);

    const sesSender = new SesV2Sender({
      client: new SESv2Client({}),
      configurationSetName: this.config.sesConfigurationSet,
    });

    // The REST handler is the only component holding a write grant on the auth table, so it
    // is the only one that may generate and claim the signing key on a virgin deployment.
    const signingKeyProvider = new DdbSigningKeyProvider(authDao);

    return {
      authDao,
      apiKeysDao,
      emailsDao,
      downloadTokensDao,
      signingKeyProvider,
      authService: new AuthService({ authDao, signingKey: signingKeyProvider }),
      apiKeyService: new ApiKeyService({ apiKeysDao }),
      emailService: new EmailService({
        ses: sesSender,
        emailsDao,
        objectStore: outboundStore,
        bodies: bodyStore,
        tokensDao: downloadTokensDao,
        uploads: uploadStore,
        ...embedLimits(this.config),
        downloadBaseUrl: this.config.downloadBaseUrl,
        emailDomain: this.config.emailDomain,
      }),
      emailReadService: new EmailReadService({
        emailsDao,
        presigner,
        quarantinePresigner,
        bodies: bodyStore,
        rawMime: inboundStore,
      }),
      downloadService: new DownloadService({ tokensDao: downloadTokensDao, presigner }),
      attachmentUploadService: new AttachmentUploadService({ uploads: uploadStore }),
    };
  }
}
