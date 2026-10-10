/**
 * Attachment transfer through presigned S3 URLs — both directions of the bytes that never pass
 * through the API.
 *
 * **Upload** (`createAttachmentUpload`): the first step of sending an attachment. The REST
 * route (`POST /attachments/uploads`) and the MCP `create_attachment_upload` tool are both thin
 * wrappers over it, so the validation can never drift between them. An upload is a presigned
 * PUT straight to S3 (`uploads/<uploadId>`). The id is random and unguessable; a send then
 * references it, and the send path trusts only what S3 reports was actually uploaded. Unsent
 * uploads are swept by a lifecycle rule on `uploads/`.
 *
 * **Download by link** (`resolveAttachmentDownloadPresignedUrl`): the read side of a linked
 * attachment (#14) — resolve a `GET /d/{token}` to a short-lived presigned S3 GET. The token is
 * the sole capability on an UNAUTHENTICATED endpoint, so every failure — unknown, revoked,
 * expired, or exhausted — resolves to `null`, which the route renders as one uniform `404`.
 * There is no oracle and no S3 disclosure before validation: the bucket/key live only in the
 * token row, and the client only ever sees a 302 to a freshly minted, short-lived presigned URL
 * forcing an octet-stream download.
 *
 * The two methods sit behind different gates — the upload route is authorized, the link is
 * public — and those gates live in the routes, not here.
 */
import { randomBytes } from 'node:crypto';
import {
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  type CreateAttachmentUploadRequest,
  type CreateAttachmentUploadResponse,
} from '@freemail/shared';
import type { DownloadTokensDao } from '../data/download-tokens-dao.js';
import type { AttachmentPresigner } from '../facades/s3-attachment-presigner.js';
import type { UploadStore } from '../facades/s3-upload-store.js';
import { contentDispositionForDownload } from '../utils/content-disposition.js';
import { isValidDownloadToken } from '../utils/download-token.js';
import { emailErrors } from '../utils/errors.js';

/** Max length of an attachment filename (it becomes a MIME header parameter and S3 metadata). */
const MAX_FILENAME_CHARS = 255;

/**
 * Max length of the filename once URI-encoded, as it is stored in S3 user metadata — which S3
 * caps at 2 KB in all. Long non-ASCII names (each character encodes to up to 12 bytes) hit this
 * before the character limit.
 */
const MAX_ENCODED_FILENAME_BYTES = 1800;
/** Max length of a declared content type. */
const MAX_CONTENT_TYPE_CHARS = 128;
/** `type/subtype` with an optional parameter list — enough to reject garbage, not full RFC 2045. */
const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/;
/** 16 random bytes, base64url: 22 characters. */
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Where an upload lives in the mail bucket. */
export function uploadKey(uploadId: string): string {
  return `uploads/${uploadId}`;
}

/** True when `value` has the shape of an upload id this service mints (checked before any S3 call). */
export function isValidUploadId(value: unknown): value is string {
  return typeof value === 'string' && UPLOAD_ID_RE.test(value);
}

export type CreateAttachmentUploadServiceRequest = CreateAttachmentUploadRequest;

export interface ResolveAttachmentDownloadPresignedUrlServiceRequest {
  /** The presented token — the SOLE capability for this unauthenticated download. */
  readonly token: string;
}

export interface ResolveAttachmentDownloadPresignedUrlServiceResponse {
  /** A freshly minted, short-lived presigned GET. The bucket and key are never disclosed. */
  readonly url: string;
}

/** What an authorized upload surface (the REST route, the MCP tool) may call. */
export type AttachmentUploader = Pick<AttachmentService, 'createAttachmentUpload'>;

/** What the public `/d/{token}` route may call — and nothing else. */
export type AttachmentDownloadResolver = Pick<
  AttachmentService,
  'resolveAttachmentDownloadPresignedUrl'
>;

export interface AttachmentServiceDeps {
  /** Presigns upload PUTs (`uploads/<id>`). */
  readonly uploads: UploadStore;
  /** The download tokens a link presents; claimed (gate + count) on each download. */
  readonly tokensDao: DownloadTokensDao;
  /** Presigns the GET a resolved link redirects to. */
  readonly presigner: AttachmentPresigner;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Upload-id generator, injectable for tests. */
  readonly generateId?: () => string;
  /** Presigned-GET lifetime for a link: short, minted per click (default: the shared constant). */
  readonly presignTtlSeconds?: number;
}

export class AttachmentService {
  private readonly uploads: UploadStore;
  private readonly tokensDao: DownloadTokensDao;
  private readonly presigner: AttachmentPresigner;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly presignTtlSeconds: number;

  constructor(deps: AttachmentServiceDeps) {
    this.uploads = deps.uploads;
    this.tokensDao = deps.tokensDao;
    this.presigner = deps.presigner;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => randomBytes(16).toString('base64url'));
    this.presignTtlSeconds = deps.presignTtlSeconds ?? DOWNLOAD_PRESIGN_TTL_SECONDS;
  }

  async createAttachmentUpload(
    request: CreateAttachmentUploadServiceRequest,
  ): Promise<CreateAttachmentUploadResponse> {
    const filename = typeof request.filename === 'string' ? request.filename.trim() : '';
    if (filename.length === 0 || filename.length > MAX_FILENAME_CHARS) {
      throw emailErrors.invalidRequest(
        `"filename" must be a non-empty string of at most ${MAX_FILENAME_CHARS} characters.`,
      );
    }
    if (encodeURIComponent(filename).length > MAX_ENCODED_FILENAME_BYTES) {
      throw emailErrors.invalidRequest('"filename" is too long — shorten it and try again.');
    }
    const contentType = normalizeContentType(request.contentType);
    const sizeBytes = request.sizeBytes;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw emailErrors.invalidRequest(
        `"sizeBytes" must be a whole number of bytes from 1 to ${MAX_UPLOAD_BYTES}.`,
      );
    }

    const uploadId = this.generateId();
    const uploadUrl = await this.uploads.presignPut(
      uploadKey(uploadId),
      { filename, contentType, sizeBytes },
      UPLOAD_URL_TTL_SECONDS,
    );
    const expiresAt = new Date(this.now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
    return { uploadId, uploadUrl, uploadMethod: 'PUT', expiresAt };
  }

  /**
   * Resolve a download link's token to a presigned download URL, or `null` when the token is
   * missing, revoked, expired, or exhausted. The claim is atomic (gate + consume in one write),
   * so concurrent requests cannot exceed a configured download cap.
   */
  async resolveAttachmentDownloadPresignedUrl(
    request: ResolveAttachmentDownloadPresignedUrlServiceRequest,
  ): Promise<ResolveAttachmentDownloadPresignedUrlServiceResponse | null> {
    // Reject anything not shaped like a minted token BEFORE any DB call — an overlong
    // token would otherwise throw a DynamoDB ValidationException (500), breaking the
    // uniform-404 contract. Empty / invalid-char tokens fail closed here too.
    if (!isValidDownloadToken(request.token)) {
      return null;
    }
    const record = await this.tokensDao.claimDownloadToken({
      token: request.token,
      nowIso: this.now().toISOString(),
    });
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

function normalizeContentType(value: unknown): string {
  if (value === undefined || value === '') {
    return 'application/octet-stream';
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_CONTENT_TYPE_CHARS ||
    !CONTENT_TYPE_RE.test(value.trim())
  ) {
    throw emailErrors.invalidRequest('"contentType" must be a MIME type such as application/pdf.');
  }
  return value.trim();
}
