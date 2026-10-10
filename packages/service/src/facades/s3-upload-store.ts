/**
 * The S3 port for attachment uploads, plus its S3 implementation. A client never sends
 * attachment bytes through the API: it asks for a presigned PUT, uploads the file straight to
 * `uploads/<id>` in the mail bucket, and then references the upload by id when it sends. The
 * send path reads what was really uploaded (a HEAD — never the client's word) and copies it to
 * its permanent key. Only this file touches `@aws-sdk/client-s3` for uploads.
 *
 * The presigned URL pins the upload's exact length (a signed `Content-Length`) and carries the
 * declared filename + content type as signed query parameters (S3 stores them as object
 * metadata), so neither can be altered by whoever holds the URL.
 */
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** What a client declared when it created the upload, stored as object metadata. */
export interface UploadDeclaration {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** A finished upload, as S3 reports it. */
export interface UploadedObject {
  /** The real size of the stored bytes. */
  readonly sizeBytes: number;
  readonly filename: string;
  readonly contentType: string;
}

export interface UploadStore {
  /** A presigned PUT for exactly `declaration.sizeBytes` bytes at `key`. */
  presignPut(
    key: string,
    declaration: UploadDeclaration,
    expiresInSeconds: number,
  ): Promise<string>;
  /** What was uploaded at `key`, or null when nothing was (never uploaded, or expired). */
  head(key: string): Promise<UploadedObject | null>;
  /** Copy an upload to its permanent key, stored as a non-inline download. */
  copy(sourceKey: string, destKey: string): Promise<void>;
  /** The bytes at `key` (for embedding a small attachment). */
  getBytes(key: string): Promise<Buffer>;
}

/** Metadata keys (S3 lowercases them); values are URI-encoded so any filename survives. */
const META_FILENAME = 'filename';
const META_CONTENT_TYPE = 'content-type';
const NOT_FOUND = new Set(['NotFound', 'NoSuchKey']);

export class S3UploadStore implements UploadStore {
  private readonly client: S3Client;

  /**
   * `presignClient` signs the upload URLs. It must be built with
   * `requestChecksumCalculation: 'WHEN_REQUIRED'`: otherwise the SDK presigns a checksum of
   * the EMPTY body it was given, and every real upload fails S3's checksum check.
   */
  constructor(
    client: S3Client,
    private readonly presignClient: S3Client,
    private readonly bucket: string,
  ) {
    this.client = client;
  }

  presignPut(
    key: string,
    declaration: UploadDeclaration,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: declaration.sizeBytes,
        Metadata: {
          [META_FILENAME]: encodeURIComponent(declaration.filename),
          [META_CONTENT_TYPE]: encodeURIComponent(declaration.contentType),
        },
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<UploadedObject | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        sizeBytes: out.ContentLength ?? 0,
        filename: decodeMeta(out.Metadata?.[META_FILENAME]) ?? 'attachment',
        contentType: decodeMeta(out.Metadata?.[META_CONTENT_TYPE]) ?? 'application/octet-stream',
      };
    } catch (err) {
      if (err instanceof Error && NOT_FOUND.has(err.name)) {
        return null;
      }
      throw err;
    }
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        // CopySource is `<bucket>/<key>` with the key URL-encoded (its `/` separators kept).
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        // Served only as a download, whatever the uploader claimed.
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment',
      }),
    );
  }

  async getBytes(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }
    return Buffer.from(await out.Body.transformToByteArray());
  }
}

function decodeMeta(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
