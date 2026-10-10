/**
 * Create attachment uploads — the first step of sending an attachment. The REST route
 * (`POST /attachments/uploads`) and the MCP `create_attachment_upload` tool are both thin
 * wrappers over this one service, so the validation can never drift between them.
 *
 * An upload is a presigned PUT straight to S3 (`uploads/<uploadId>`): the bytes never pass
 * through the API. The id is random and unguessable; a send then references it, and the send
 * path trusts only what S3 reports was actually uploaded. Unsent uploads are swept by a
 * lifecycle rule on `uploads/`.
 */
import { randomBytes } from 'node:crypto';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  type CreateAttachmentUploadRequest,
  type CreateAttachmentUploadResponse,
} from '@freemail/shared';
import type { UploadStore } from '../facades/s3-upload-store.js';
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

export interface AttachmentUploadServiceDeps {
  readonly uploads: UploadStore;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
  /** Upload-id generator, injectable for tests. */
  readonly generateId?: () => string;
}

export class AttachmentUploadService {
  private readonly uploads: UploadStore;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: AttachmentUploadServiceDeps) {
    this.uploads = deps.uploads;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? (() => randomBytes(16).toString('base64url'));
  }

  async create(
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
