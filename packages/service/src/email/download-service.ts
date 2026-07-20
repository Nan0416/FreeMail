/**
 * The read side of the outbound large-attachment flow (#14): resolve a `GET /d/{token}`
 * request to a short-lived presigned S3 GET. Injectable (tokens repo + presigner + clock)
 * so every branch is testable without AWS.
 *
 * The token is the sole capability on an UNAUTHENTICATED endpoint, so every failure —
 * unknown, revoked, expired, or exhausted — resolves to `null`, which the handler renders
 * as one uniform `404`. There is no oracle and no S3 disclosure before validation: the
 * bucket/key live only in the token row, and the client only ever sees a 302 to a freshly
 * minted, 60-second presigned URL forcing an octet-stream download.
 */
import { DOWNLOAD_PRESIGN_TTL_SECONDS } from '@freemail/shared';
import type { AttachmentPresigner } from '../data/s3-attachment-presigner.js';
import type { DownloadTokensRepo } from '../data/download-tokens-repo.js';
import { contentDispositionForDownload } from './content-disposition.js';
import { isValidDownloadToken } from './download-token.js';

export interface DownloadServiceDeps {
  readonly tokens: DownloadTokensRepo;
  readonly presigner: AttachmentPresigner;
  readonly now?: () => Date;
  /** Presigned-GET lifetime; short, minted per click. Defaults to the shared constant. */
  readonly presignTtlSeconds?: number;
}

export class DownloadService {
  private readonly tokens: DownloadTokensRepo;
  private readonly presigner: AttachmentPresigner;
  private readonly now: () => Date;
  private readonly presignTtlSeconds: number;

  constructor(deps: DownloadServiceDeps) {
    this.tokens = deps.tokens;
    this.presigner = deps.presigner;
    this.now = deps.now ?? (() => new Date());
    this.presignTtlSeconds = deps.presignTtlSeconds ?? DOWNLOAD_PRESIGN_TTL_SECONDS;
  }

  /**
   * Resolve a token to a presigned download URL, or `null` when the token is missing,
   * revoked, expired, or exhausted. The claim is atomic (gate + consume in one write), so
   * concurrent requests cannot exceed a configured download cap.
   */
  async resolve(token: string): Promise<{ url: string } | null> {
    // Reject anything not shaped like a minted token BEFORE any DB call — an overlong
    // token would otherwise throw a DynamoDB ValidationException (500), breaking the
    // uniform-404 contract. Empty / invalid-char tokens fail closed here too.
    if (!isValidDownloadToken(token)) {
      return null;
    }
    const record = await this.tokens.claim(token, this.now().toISOString());
    if (!record) {
      return null;
    }
    const url = await this.presigner.presign({
      key: record.s3Key,
      // Force a non-inline download regardless of the object's stored metadata.
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload(record.filename),
      expiresInSeconds: this.presignTtlSeconds,
    });
    return { url };
  }
}
