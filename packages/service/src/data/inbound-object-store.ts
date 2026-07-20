/**
 * The S3 port the inbound processor uses, plus its S3 implementation. The processor
 * depends on the interface so its logic is testable with a fake; only this file
 * touches `@aws-sdk/client-s3`.
 *
 * Extracted attachments are stored as `application/octet-stream` with
 * `Content-Disposition: attachment`, so even a naked GET of the object serves it as
 * a download rather than an inline-renderable type — defense in depth beneath the
 * presigned-download flow the read slice (#11) adds.
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Trusted object metadata from a HEAD — the size gate + the stable receipt time. */
export interface ObjectHead {
  readonly sizeBytes: number;
  readonly lastModified: Date;
}

export interface InboundObjectStore {
  /** HEAD an object; null if it does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Open a readable stream over an object's bytes. */
  getStream(key: string): Promise<Readable>;
  /** Store an extracted attachment (always as a non-inline download). */
  putAttachment(key: string, body: Buffer): Promise<void>;
  /** Best-effort delete — used to clean up attachments written during a failed attempt. */
  deleteObject(key: string): Promise<void>;
}

/** S3 error name for a missing object on HEAD. */
const NOT_FOUND = 'NotFound';

export class S3InboundObjectStore implements InboundObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        sizeBytes: out.ContentLength ?? 0,
        lastModified: out.LastModified ?? new Date(0),
      };
    } catch (err) {
      if (err instanceof Error && (err.name === NOT_FOUND || err.name === 'NoSuchKey')) {
        return null;
      }
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }
    // In the Lambda Node runtime the SDK returns a Node Readable.
    return out.Body as Readable;
  }

  async putAttachment(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment',
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
