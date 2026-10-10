import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3MailBodyStore, parseStoredBody } from '../../src/facades/s3-mail-body-store.js';

/** Stores PUT bodies and serves them back to GETs; a queued error answers the next GET. */
class FakeS3 {
  readonly objects = new Map<string, string>();
  getError?: Error;
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      this.objects.set(String(command.input.Key), String(command.input.Body));
      return Promise.resolve({});
    }
    if (this.getError) {
      return Promise.reject(this.getError);
    }
    const stored = this.objects.get(String(command.input.Key));
    if (stored === undefined) {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      return Promise.reject(err);
    }
    return Promise.resolve({ Body: { transformToString: () => Promise.resolve(stored) } });
  }
}

describe('S3MailBodyStore', () => {
  it('round-trips a body through its JSON object', async () => {
    const fake = new FakeS3();
    const store = new S3MailBodyStore(fake as unknown as S3Client, 'mail-bucket');

    await store.putBody('bodies/sent/s1.json', { text: 't', html: '<p>h</p>', truncated: true });

    expect(await store.getBody('bodies/sent/s1.json')).toEqual({
      text: 't',
      html: '<p>h</p>',
      truncated: true,
    });
  });

  it('answers null for a missing object', async () => {
    const store = new S3MailBodyStore(new FakeS3() as unknown as S3Client, 'mail-bucket');
    expect(await store.getBody('bodies/inbound/gone.json')).toBeNull();
  });

  it('rethrows any other S3 failure', async () => {
    const fake = new FakeS3();
    fake.getError = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const store = new S3MailBodyStore(fake as unknown as S3Client, 'mail-bucket');

    await expect(store.getBody('bodies/inbound/x.json')).rejects.toThrow(/Access Denied/);
  });
});

describe('parseStoredBody', () => {
  it('keeps only well-typed fields from a damaged object', () => {
    expect(
      parseStoredBody(JSON.stringify({ text: 42, html: '<p>ok</p>', truncated: 'yes' })),
    ).toEqual({ html: '<p>ok</p>' });
  });

  it('yields no body for malformed JSON or a non-object', () => {
    expect(parseStoredBody('{not json')).toBeNull();
    expect(parseStoredBody('"a string"')).toBeNull();
    expect(parseStoredBody('[1, 2]')).toBeNull();
    expect(parseStoredBody('null')).toBeNull();
  });
});
