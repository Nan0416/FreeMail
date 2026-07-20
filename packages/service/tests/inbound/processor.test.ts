import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EmailsRepo, InboundEmailRecord } from '../../src/data/emails-repo.js';
import type { InboundObjectStore, ObjectHead } from '../../src/data/inbound-object-store.js';
import { MAX_ATTACHMENTS } from '../../src/inbound/limits.js';
import { ATTACHMENTS_PREFIX, InboundProcessor } from '../../src/inbound/processor.js';

const RECEIVED = new Date('2026-05-01T09:30:00.000Z');

class FakeStore implements InboundObjectStore {
  readonly heads = new Map<string, ObjectHead>();
  readonly objects = new Map<string, string>();
  readonly putKeys: string[] = [];
  readonly deletedKeys: string[] = [];
  headCalls = 0;
  getCalls = 0;
  /** Optional: make putAttachment fail (simulate an S3 infra error). */
  putShouldThrow = false;

  head(key: string): Promise<ObjectHead | null> {
    this.headCalls++;
    return Promise.resolve(this.heads.get(key) ?? null);
  }
  getStream(key: string): Promise<Readable> {
    this.getCalls++;
    const body = this.objects.get(key);
    if (body === undefined) {
      throw new Error(`no object ${key}`);
    }
    return Promise.resolve(Readable.from(Buffer.from(body)));
  }
  putAttachment(key: string): Promise<void> {
    if (this.putShouldThrow) {
      return Promise.reject(new Error('s3 put failed'));
    }
    this.putKeys.push(key);
    return Promise.resolve();
  }
  deleteObject(key: string): Promise<void> {
    this.deletedKeys.push(key);
    return Promise.resolve();
  }
}

class FakeRepo implements EmailsRepo {
  readonly inbound: InboundEmailRecord[] = [];
  readonly existingIds = new Set<string>();
  putSent(): Promise<void> {
    return Promise.resolve();
  }
  putInbound(record: InboundEmailRecord): Promise<boolean> {
    if (this.existingIds.has(record.id)) {
      return Promise.resolve(false);
    }
    this.inbound.push(record);
    return Promise.resolve(true);
  }
}

/** Seed a store with one object at inbound/<id>. */
function seed(store: FakeStore, id: string, raw: string, sizeBytes = raw.length): void {
  const key = `inbound/${id}`;
  store.heads.set(key, { sizeBytes, lastModified: RECEIVED });
  store.objects.set(key, raw);
}

const CLEAN_TEXT = [
  'X-SES-Spam-Verdict: PASS',
  'X-SES-Virus-Verdict: PASS',
  'From: Alice <a@x.com>',
  'To: b@y.com',
  'Subject: Hi',
  'Date: Fri, 01 Jan 2100 00:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello there',
  '',
].join('\r\n');

function withAttachment(virus: string): string {
  return [
    'X-SES-Spam-Verdict: PASS',
    `X-SES-Virus-Verdict: ${virus}`,
    'From: a@x.com',
    'Subject: attach',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="r.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'SGVsbG8gUERG',
    '--B--',
    '',
  ].join('\r\n');
}

function manyAttachments(n: number): string {
  const parts = [
    'X-SES-Spam-Verdict: PASS',
    'X-SES-Virus-Verdict: PASS',
    'From: a@x.com',
    'Subject: many',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
  ];
  for (let i = 0; i < n; i++) {
    parts.push(
      '--B',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename="f${i}.bin"`,
      '',
      'data',
      '',
    );
  }
  parts.push('--B--', '');
  return parts.join('\r\n');
}

describe('InboundProcessor', () => {
  it('indexes a clean message: server-trusted receivedAt, snippet, no attachments', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    seed(store, 'MSG1', CLEAN_TEXT);
    const result = await new InboundProcessor(store, repo).process('inbound/MSG1');

    expect(result).toEqual({ outcome: 'indexed', messageId: 'MSG1' });
    const row = repo.inbound[0]!;
    expect(row.id).toBe('MSG1');
    expect(row.rawS3Key).toBe('inbound/MSG1');
    // receivedAt is the trusted S3 timestamp; the attacker's 2100 Date is display-only.
    expect(row.receivedAt).toBe('2026-05-01T09:30:00.000Z');
    expect(row.headerDate).toBe('2100-01-01T00:00:00.000Z');
    expect(row.from).toBe('a@x.com');
    expect(row.subject).toBe('Hi');
    expect(row.snippet).toContain('Hello there');
    expect(row.quarantined).toBe(false);
    expect(row.attachments).toEqual([]);
  });

  it('extracts attachments to a key OUTSIDE inbound/ (no recursive re-trigger)', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    seed(store, 'MSG2', withAttachment('PASS'));
    const result = await new InboundProcessor(store, repo).process('inbound/MSG2');

    expect(result.outcome).toBe('indexed');
    expect(store.putKeys).toEqual([`${ATTACHMENTS_PREFIX}MSG2/0`]);
    expect(store.putKeys[0]!.startsWith('attachments/inbound/')).toBe(true);
    expect(store.putKeys[0]!.startsWith('inbound/')).toBe(false);
    const row = repo.inbound[0]!;
    expect(row.attachments[0]).toMatchObject({
      id: '0',
      filename: 'r.pdf',
      s3Key: 'attachments/inbound/MSG2/0',
    });
  });

  it('virus FAIL: quarantined, no extraction, no snippet, but records that an attachment existed', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    seed(store, 'MSG3', withAttachment('FAIL'));
    const result = await new InboundProcessor(store, repo).process('inbound/MSG3');

    expect(result.outcome).toBe('quarantined');
    const row = repo.inbound[0]!;
    expect(row.virusVerdict).toBe('FAIL');
    expect(row.quarantined).toBe(true);
    expect(row.hasAttachments).toBe(true);
    expect(row.attachmentCount).toBe(1);
    expect(row.attachments).toEqual([]);
    expect(row.snippet).toBeUndefined();
    expect(store.putKeys).toEqual([]); // never materialized the malware
  });

  it('oversize object: quarantined WITHOUT downloading or parsing', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    // HEAD reports a size over the raw cap; the body is never fetched.
    store.heads.set('inbound/BIG', { sizeBytes: 41 * 1024 * 1024, lastModified: RECEIVED });
    const result = await new InboundProcessor(store, repo).process('inbound/BIG');

    expect(result.outcome).toBe('quarantined');
    expect(store.getCalls).toBe(0); // never downloaded
    const row = repo.inbound[0]!;
    expect(row.parseStatus).toBe('oversize');
    expect(row.quarantined).toBe(true);
    expect(row.attachments).toEqual([]);
  });

  it('limit breach: quarantines and cleans up attachments written during the failed attempt', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    // One more attachment than the default cap → limit_exceeded after the cap is filled.
    seed(store, 'MANY', manyAttachments(MAX_ATTACHMENTS + 1));
    const result = await new InboundProcessor(store, repo).process('inbound/MANY');

    expect(result.outcome).toBe('quarantined');
    const row = repo.inbound[0]!;
    expect(row.parseStatus).toBe('limit_exceeded');
    expect(row.attachments).toEqual([]); // no partial publish
    // Everything written this attempt was cleaned up (and is unreferenced regardless).
    expect(store.putKeys.length).toBeGreaterThan(0);
    expect(store.deletedKeys.sort()).toEqual([...store.putKeys].sort());
  });

  it('duplicate redelivery: the conditional put no-ops → "duplicate"', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    repo.existingIds.add('MSG1');
    seed(store, 'MSG1', CLEAN_TEXT);
    const result = await new InboundProcessor(store, repo).process('inbound/MSG1');
    expect(result).toEqual({ outcome: 'duplicate', messageId: 'MSG1' });
  });

  it('malformed event key: skipped, never touches S3 or DDB', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    const result = await new InboundProcessor(store, repo).process('inbound/a/b/traversal');
    expect(result.outcome).toBe('skipped');
    expect(store.headCalls).toBe(0);
    expect(repo.inbound).toEqual([]);
  });

  it('missing object: skipped (HEAD returns null)', async () => {
    const store = new FakeStore();
    const repo = new FakeRepo();
    const result = await new InboundProcessor(store, repo).process('inbound/GONE');
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('object not found');
    expect(repo.inbound).toEqual([]);
  });

  it('infra failure (S3 put) propagates as a rejection so the invocation retries', async () => {
    const store = new FakeStore();
    store.putShouldThrow = true;
    const repo = new FakeRepo();
    seed(store, 'MSG2', withAttachment('PASS'));
    await expect(new InboundProcessor(store, repo).process('inbound/MSG2')).rejects.toThrow(
      's3 put failed',
    );
    expect(repo.inbound).toEqual([]); // no row committed on an infra failure
  });
});
