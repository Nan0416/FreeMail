/**
 * The read-only S3 port the forwarder uses to fetch a received message's raw MIME, plus its S3
 * implementation. Narrower than the inbound parser's object store on purpose: the forwarder
 * reads raw mail and never writes or deletes it.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export interface RawMessageReader {
  /** The whole object, or null when it no longer exists (raw inbound MIME expires). */
  getRawMessage(key: string): Promise<Buffer | null>;
}

export class S3RawMessageReader implements RawMessageReader {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async getRawMessage(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : Buffer.alloc(0);
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchKey') {
        return null;
      }
      throw err;
    }
  }
}
