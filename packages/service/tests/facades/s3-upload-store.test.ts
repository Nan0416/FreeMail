import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3UploadStore } from '../../src/facades/s3-upload-store.js';

class FakeS3 {
  readonly calls: unknown[] = [];
  headResult: unknown = {};
  headError?: Error;
  send(command: unknown): Promise<unknown> {
    this.calls.push(command);
    if (command instanceof HeadObjectCommand) {
      return this.headError ? Promise.reject(this.headError) : Promise.resolve(this.headResult);
    }
    return Promise.resolve({});
  }
}

function store(fake = new FakeS3()) {
  // A real client signs the URL (offline, with dummy credentials), as production does.
  const presignClient = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIA', secretAccessKey: 'x' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return { fake, s: new S3UploadStore(fake as unknown as S3Client, presignClient, 'mail-bucket') };
}

describe('S3UploadStore', () => {
  it('presigns a PUT that pins the length and carries the declaration as signed metadata', async () => {
    const url = new URL(
      await store().s.presignPut(
        'uploads/AAAAAAAAAAAAAAAAAAAAAA',
        { filename: 'résumé 1.pdf', contentType: 'application/pdf', sizeBytes: 1234 },
        900,
      ),
    );

    expect(url.host).toBe('mail-bucket.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/uploads/AAAAAAAAAAAAAAAAAAAAAA');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('x-amz-meta-filename')).toBe(encodeURIComponent('résumé 1.pdf'));
    expect(url.searchParams.get('x-amz-meta-content-type')).toBe(
      encodeURIComponent('application/pdf'),
    );
    // No presigned checksum of an empty body (which would fail every real upload).
    expect([...url.searchParams.keys()].some((k) => k.startsWith('x-amz-checksum'))).toBe(false);
  });

  it('reads back what was really uploaded, decoding the metadata', async () => {
    const t = store();
    t.fake.headResult = {
      ContentLength: 1234,
      Metadata: { filename: encodeURIComponent('résumé.pdf'), 'content-type': 'application%2Fpdf' },
    };

    expect(await t.s.head('uploads/x')).toEqual({
      sizeBytes: 1234,
      filename: 'résumé.pdf',
      contentType: 'application/pdf',
    });
  });

  it('answers null when nothing was uploaded, and rethrows anything else', async () => {
    const t = store();
    t.fake.headError = Object.assign(new Error('not found'), { name: 'NotFound' });
    expect(await t.s.head('uploads/x')).toBeNull();
    t.fake.headError = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    await expect(t.s.head('uploads/x')).rejects.toThrow(/denied/);
  });

  it('copies an upload to its permanent key as a forced download', async () => {
    const t = store();
    await t.s.copy('uploads/AAAAAAAAAAAAAAAAAAAAAA', 'attachments/sent/e1/0');

    const copy = t.fake.calls[0] as CopyObjectCommand;
    expect(copy).toBeInstanceOf(CopyObjectCommand);
    expect(copy.input).toEqual({
      Bucket: 'mail-bucket',
      Key: 'attachments/sent/e1/0',
      CopySource: 'mail-bucket/uploads/AAAAAAAAAAAAAAAAAAAAAA',
      MetadataDirective: 'REPLACE',
      ContentType: 'application/octet-stream',
      ContentDisposition: 'attachment',
    });
  });
});
