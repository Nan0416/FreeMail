/**
 * The S3 port the send path uses to store an outbound LARGE attachment (#14), plus its
 * S3 implementation. The {@link ../email/service.EmailService} depends on the interface
 * so its embed-vs-link logic is testable with a fake; only this file touches
 * `@aws-sdk/client-s3`.
 *
 * Objects are written `application/octet-stream` with `Content-Disposition: attachment`
 * (mirroring the inbound store), so even a naked GET serves them as a download, never an
 * inline-renderable type — defense in depth beneath the token-gated presigned download.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface OutboundAttachmentStore {
  /** Store one outbound attachment's bytes at a server-chosen key (as a non-inline download). */
  put(key: string, body: Buffer): Promise<void>;
}

export class S3OutboundAttachmentStore implements OutboundAttachmentStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  async put(key: string, body: Buffer): Promise<void> {
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
}
