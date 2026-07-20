/**
 * Mints short-lived presigned S3 GET URLs for attachment downloads. The port is
 * injected into the read service so the download logic is testable with a fake; only
 * this file touches the S3 SDK + the presigner.
 *
 * The presign FORCES the response to download, never render: `ResponseContentType`
 * `application/octet-stream` + a `ResponseContentDisposition: attachment` header carry
 * into the signed URL's query params → S3 sets those on the GET response. This holds
 * regardless of the stored object's own metadata (which #10 already set the same way),
 * so a served attachment can never be sniffed into inline-rendered active content.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignRequest {
  /** Server-owned S3 key — never client-supplied, never returned to the client. */
  readonly key: string;
  /** Value for the response `Content-Type` header (forced to a non-inline type). */
  readonly contentType: string;
  /** Value for the response `Content-Disposition` header (always `attachment`, safely encoded). */
  readonly contentDisposition: string;
  readonly expiresInSeconds: number;
}

/** Presigns an attachment download; returns just the URL (the caller stamps `expiresAt`). */
export interface AttachmentPresigner {
  presign(req: PresignRequest): Promise<string>;
}

export class S3AttachmentPresigner implements AttachmentPresigner {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  presign(req: PresignRequest): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: req.key,
      ResponseContentType: req.contentType,
      ResponseContentDisposition: req.contentDisposition,
    });
    return getSignedUrl(this.client, command, { expiresIn: req.expiresInSeconds });
  }
}
