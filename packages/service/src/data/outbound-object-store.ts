/**
 * The S3 port the send path uses to write objects to the mail bucket, plus its S3
 * implementation. Two kinds of object flow through it: outbound LARGE attachments (#14,
 * `attachments/outbound/*`) and the archived composed raw MIME of a sent message (#29,
 * `sent/*`). The {@link ../email/service.EmailService} depends on the interface so its
 * embed-vs-link + archive logic is testable with a fake; only this file touches
 * `@aws-sdk/client-s3`.
 *
 * Objects are written `application/octet-stream` with `Content-Disposition: attachment`
 * (mirroring the inbound store), so even a naked GET serves them as a download, never an
 * inline-renderable type. That disposition is irrelevant to the sent MIME archive (it is
 * only ever re-read server-side for the read path), but harmless — one write path for both.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface OutboundObjectStore {
  /** Store bytes at a server-chosen mail-bucket key (as a non-inline download). */
  put(key: string, body: Buffer): Promise<void>;
}

export class S3OutboundObjectStore implements OutboundObjectStore {
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
