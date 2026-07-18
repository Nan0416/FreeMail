import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3OutboundAttachmentStore } from './outbound-attachment-store.js';

class FakeS3 {
  readonly calls: PutObjectCommand[] = [];
  send(command: PutObjectCommand): Promise<unknown> {
    this.calls.push(command);
    return Promise.resolve({});
  }
}

describe('S3OutboundAttachmentStore', () => {
  it('puts the bytes as a non-inline octet-stream download at the given key', async () => {
    const fake = new FakeS3();
    const store = new S3OutboundAttachmentStore('mail-bucket', fake as unknown as S3Client);
    const body = Buffer.from('the-file-bytes');

    await store.put('attachments/outbound/email-1/0', body);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toBeInstanceOf(PutObjectCommand);
    expect(fake.calls[0].input).toEqual({
      Bucket: 'mail-bucket',
      Key: 'attachments/outbound/email-1/0',
      Body: body,
      // Defense in depth: even a naked GET serves it as a download, never inline-rendered.
      ContentType: 'application/octet-stream',
      ContentDisposition: 'attachment',
    });
  });
});
