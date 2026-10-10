/**
 * The S3 port the send path uses to archive the composed raw MIME of a sent message (#29,
 * `sent/*`), plus its S3 implementation. (Attachments no longer flow through here: they are
 * uploaded directly and copied by the upload store.) The {@link EmailService} depends on the
 * interface so its archive step is testable with a fake; only this file touches
 * `@aws-sdk/client-s3` for it.
 *
 * Objects are written `application/octet-stream` with `Content-Disposition: attachment`
 * (mirroring the inbound store), so even a naked GET serves them as a download, never an
 * inline-renderable type — irrelevant to the archive (only ever re-read server-side), but
 * harmless.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface OutboundObjectStore {
  /** Store bytes at a server-chosen mail-bucket key (as a non-inline download). */
  put(key: string, body: Buffer): Promise<void>;
}

export class S3OutboundObjectStore implements OutboundObjectStore {
  private readonly client: S3Client;

  constructor(
    client: S3Client,
    private readonly bucket: string,
  ) {
    this.client = client;
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
