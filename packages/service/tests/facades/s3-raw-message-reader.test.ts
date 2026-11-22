import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3RawMessageReader } from '../../src/facades/s3-raw-message-reader.js';

function fakeS3(result: { body?: Uint8Array; error?: string }): {
  client: S3Client;
  calls: GetObjectCommand[];
} {
  const calls: GetObjectCommand[] = [];
  const client = {
    send(command: GetObjectCommand): Promise<unknown> {
      calls.push(command);
      if (result.error) {
        const err = new Error(result.error);
        err.name = result.error;
        return Promise.reject(err);
      }
      return Promise.resolve({
        Body: result.body ? { transformToByteArray: () => Promise.resolve(result.body) } : undefined,
      });
    },
  } as unknown as S3Client;
  return { client, calls };
}

describe('S3RawMessageReader', () => {
  it('reads the whole object from the mail bucket', async () => {
    const fake = fakeS3({ body: Buffer.from('raw mime') });

    const raw = await new S3RawMessageReader(fake.client, 'mail-bucket').getRawMessage('inbound/msg-1');

    expect(raw?.toString()).toBe('raw mime');
    expect(fake.calls[0]).toBeInstanceOf(GetObjectCommand);
    expect(fake.calls[0]?.input).toEqual({ Bucket: 'mail-bucket', Key: 'inbound/msg-1' });
  });

  it('returns null for an object that no longer exists', async () => {
    const fake = fakeS3({ error: 'NoSuchKey' });

    expect(await new S3RawMessageReader(fake.client, 'b').getRawMessage('inbound/x')).toBeNull();
  });

  it('propagates any other failure', async () => {
    const fake = fakeS3({ error: 'AccessDenied' });

    await expect(new S3RawMessageReader(fake.client, 'b').getRawMessage('k')).rejects.toThrow('AccessDenied');
  });
});
