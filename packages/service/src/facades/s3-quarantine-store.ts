/**
 * The S3 port the inbound processor uses to keep the raw MIME of a message whose content could
 * not be extracted (a virus verdict other than PASS, or a parse failure / limit breach), plus
 * its S3 implementation. SES's own copy under `inbound/` expires after a retention window, so
 * an Errors-folder message's original is copied, server-side, into a separate quarantine
 * bucket that never expires — the only way to recover such a message's content later.
 *
 * The copy is stored `application/octet-stream` with `Content-Disposition: attachment`, so even
 * a naked GET serves it as a download rather than an inline-renderable type — defense in depth
 * beneath the presigned download, which forces the same.
 */
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface QuarantineStore {
  /** Copy a mail-bucket object to `destKey` in the quarantine bucket (idempotent: overwrites). */
  copyFromMail(sourceKey: string, destKey: string): Promise<void>;
}

export class S3QuarantineStore implements QuarantineStore {
  private readonly client: S3Client;

  constructor(
    client: S3Client,
    private readonly mailBucket: string,
    private readonly quarantineBucket: string,
  ) {
    this.client = client;
  }

  async copyFromMail(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.quarantineBucket,
        Key: destKey,
        // CopySource is `<bucket>/<key>` with the key URL-encoded (its `/` separators kept).
        CopySource: `${this.mailBucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment',
        // Never inherit the source's tags (a redelivered message's raw copy may already carry
        // the ingested tag) — no lifecycle rule should ever reach a quarantined original.
        TaggingDirective: 'REPLACE',
      }),
    );
  }
}
