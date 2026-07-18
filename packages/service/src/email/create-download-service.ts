/**
 * Constructs a {@link DownloadService} from the Lambda environment, caching the tokens
 * repo and presigner in module scope so they're reused across warm invocations. The
 * public `GET /d/{token}` route (in the REST handler) builds the service through this one
 * place — mirroring the other `createXFromEnv` factories.
 */
import { DdbDownloadTokensRepo } from '../data/ddb-download-tokens-repo.js';
import { S3AttachmentPresigner } from '../data/s3-attachment-presigner.js';
import { DownloadService } from './download-service.js';

let tokensRepo: DdbDownloadTokensRepo | undefined;
let presigner: S3AttachmentPresigner | undefined;

export function createDownloadServiceFromEnv(): DownloadService {
  const tableName = process.env.DOWNLOAD_TOKENS_TABLE;
  if (!tableName) {
    throw new Error('DOWNLOAD_TOKENS_TABLE is not set.');
  }
  const mailBucket = process.env.MAIL_BUCKET;
  if (!mailBucket) {
    throw new Error('MAIL_BUCKET is not set.');
  }
  tokensRepo ??= new DdbDownloadTokensRepo(tableName);
  presigner ??= new S3AttachmentPresigner(mailBucket);
  return new DownloadService({ tokens: tokensRepo, presigner });
}
