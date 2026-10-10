import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  CreateInboundEmailInput,
  CreateInboundEmailOutput,
  CreateSentEmailOutput,
  EmailsDao,
  GetEmailOutput,
  ListEmailSummariesOutput,
  QueryEmailsByDirectionOutput,
  UpdateSentEmailStatusOutput,
} from '../../src/data/emails-dao.js';
import type { InboundObjectStore, ObjectHead } from '../../src/facades/s3-inbound-object-store.js';
import type { MailBodyContent, MailBodyStore } from '../../src/facades/s3-mail-body-store.js';
import type { QuarantineStore } from '../../src/facades/s3-quarantine-store.js';
import { MAX_INLINE_BODY_BYTES } from '../../src/services/email-body-storage.js';
import { MAX_ATTACHMENTS, MAX_HEADER_BLOCK_BYTES } from '../../src/utils/inbound-limits.js';
import { ATTACHMENTS_PREFIX, InboundProcessor } from '../../src/services/inbound-service.js';

const RECEIVED = new Date('2026-05-01T09:30:00.000Z');

class FakeStore implements InboundObjectStore {
  readonly heads = new Map<string, ObjectHead>();
  readonly objects = new Map<string, string>();
  readonly putKeys: string[] = [];
  readonly deletedKeys: string[] = [];
  /** Raw keys tagged as fully ingested (so the lifecycle rule may expire them). */
  readonly taggedKeys: string[] = [];
  /** Runs inside markIngested — lets a test record the order of writes. */
  onTag?: (key: string) => void;
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
  markIngested(key: string): Promise<void> {
    this.onTag?.(key);
    this.taggedKeys.push(key);
    return Promise.resolve();
  }
  /** Ranged reads: the key + byte cap of each, served from `objects`. */
  readonly headReads: { key: string; maxBytes: number }[] = [];
  getHead(key: string, maxBytes: number): Promise<Buffer> {
    this.headReads.push({ key, maxBytes });
    return Promise.resolve(Buffer.from(this.objects.get(key) ?? '').subarray(0, maxBytes));
  }
}

class FakeQuarantine implements QuarantineStore {
  readonly copies: { sourceKey: string; destKey: string }[] = [];
  /** Make the copy fail (an S3 infra error). */
  fail = false;
  /** Runs inside copyFromMail — lets a test record the order of writes. */
  onCopy?: () => void;
  copyFromMail(sourceKey: string, destKey: string): Promise<void> {
    if (this.fail) {
      return Promise.reject(new Error('s3 copy failed'));
    }
    this.onCopy?.();
    this.copies.push({ sourceKey, destKey });
    return Promise.resolve();
  }
}

class FakeDao implements EmailsDao {
  readonly inbound: CreateInboundEmailInput[] = [];
  readonly existingIds = new Set<string>();
  createSentEmail(): Promise<CreateSentEmailOutput> {
    return Promise.resolve({});
  }
  updateSentEmailStatus(): Promise<UpdateSentEmailStatusOutput> {
    return Promise.resolve({});
  }
  createInboundEmail(record: CreateInboundEmailInput): Promise<CreateInboundEmailOutput> {
    if (this.existingIds.has(record.id)) {
      return Promise.resolve({ created: false });
    }
    this.inbound.push(record);
    return Promise.resolve({ created: true });
  }
  queryEmailsByDirection(): Promise<QueryEmailsByDirectionOutput> {
    return Promise.resolve({ emails: [] });
  }
  listEmailSummaries(): Promise<ListEmailSummariesOutput> {
    return Promise.resolve({ emails: [] });
  }
  getEmail(): Promise<GetEmailOutput | null> {
    return Promise.resolve(null);
  }
}

class FakeBodyStore implements MailBodyStore {
  readonly puts = new Map<string, MailBodyContent>();
  /** Runs inside putBody — lets a test record the order of writes. */
  onPut?: (key: string) => void;
  putBody(key: string, body: MailBodyContent): Promise<void> {
    this.onPut?.(key);
    this.puts.set(key, body);
    return Promise.resolve();
  }
  getBody(key: string): Promise<MailBodyContent | null> {
    return Promise.resolve(this.puts.get(key) ?? null);
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

function cleanWithBody(body: string): string {
  return [
    'X-SES-Spam-Verdict: PASS',
    'X-SES-Virus-Verdict: PASS',
    'From: a@x.com',
    'Subject: Body',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}

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
    const repo = new FakeDao();
    seed(store, 'MSG1', CLEAN_TEXT);
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/MSG1',
    });

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

  it('stores a small body inline on the row — opening it needs no raw-MIME parse', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const bodies = new FakeBodyStore();
    seed(store, 'SMALL', CLEAN_TEXT);
    await new InboundProcessor(store, repo, bodies, new FakeQuarantine()).process({
      rawKey: 'inbound/SMALL',
    });

    const row = repo.inbound[0]!;
    expect(row.body).toEqual({ kind: 'inline', text: expect.stringContaining('Hello there') });
    expect(bodies.puts.size).toBe(0);
  });

  it('stores a large body in S3 BEFORE writing the row, and points the row at it', async () => {
    const store = new FakeStore();
    const events: string[] = [];
    const repo = new FakeDao();
    const createInbound = repo.createInboundEmail.bind(repo);
    repo.createInboundEmail = (record) => {
      events.push('row');
      return createInbound(record);
    };
    const bodies = new FakeBodyStore();
    bodies.onPut = (key) => events.push(`body:${key}`);
    // Several lines so no single line is absurdly long; together well over the inline cap.
    const line = 'x'.repeat(999);
    const big = Array.from({ length: Math.ceil(MAX_INLINE_BODY_BYTES / 1000) + 10 }, () => line);
    seed(store, 'LARGE', cleanWithBody(big.join('\r\n')));

    await new InboundProcessor(store, repo, bodies, new FakeQuarantine()).process({
      rawKey: 'inbound/LARGE',
    });

    expect(events).toEqual(['body:bodies/inbound/LARGE.json', 'row']);
    expect(repo.inbound[0]!.body).toEqual({ kind: 's3', s3Key: 'bodies/inbound/LARGE.json' });
    expect(bodies.puts.get('bodies/inbound/LARGE.json')!.text!.length).toBeGreaterThan(
      MAX_INLINE_BODY_BYTES,
    );
  });

  it('quarantines a failed message BEFORE its row, then lets the SES raw copy expire', async () => {
    const store = new FakeStore();
    const events: string[] = [];
    const repo = new FakeDao();
    const createInbound = repo.createInboundEmail.bind(repo);
    repo.createInboundEmail = (record) => {
      events.push('row');
      return createInbound(record);
    };
    const quarantine = new FakeQuarantine();
    quarantine.onCopy = () => events.push('quarantine');
    store.onTag = () => events.push('tag');
    seed(store, 'VIRUS', withAttachment('FAIL'));

    await new InboundProcessor(store, repo, new FakeBodyStore(), quarantine).process({
      rawKey: 'inbound/VIRUS',
    });

    expect(events).toEqual(['quarantine', 'row', 'tag']);
    expect(quarantine.copies).toEqual([
      { sourceKey: 'inbound/VIRUS', destKey: 'inbound/VIRUS.eml' },
    ]);
  });

  it('a failed quarantine copy writes no row and no tag — the event retries with raw intact', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const quarantine = new FakeQuarantine();
    quarantine.fail = true;
    seed(store, 'VIRUS2', withAttachment('FAIL'));

    await expect(
      new InboundProcessor(store, repo, new FakeBodyStore(), quarantine).process({
        rawKey: 'inbound/VIRUS2',
      }),
    ).rejects.toThrow(/s3 copy failed/);

    expect(repo.inbound).toEqual([]);
    expect(store.taggedKeys).toEqual([]);
  });

  it('a redelivered failed message re-copies (same key), no-ops the row, and re-tags', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    repo.existingIds.add('VIRUS3');
    const quarantine = new FakeQuarantine();
    seed(store, 'VIRUS3', withAttachment('FAIL'));

    const result = await new InboundProcessor(store, repo, new FakeBodyStore(), quarantine).process(
      { rawKey: 'inbound/VIRUS3' },
    );

    expect(result.outcome).toBe('duplicate');
    expect(quarantine.copies).toEqual([
      { sourceKey: 'inbound/VIRUS3', destKey: 'inbound/VIRUS3.eml' },
    ]);
    expect(store.taggedKeys).toEqual(['inbound/VIRUS3']);
  });

  it('a clean message is neither quarantined nor filed as failed', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const quarantine = new FakeQuarantine();
    seed(store, 'CLEAN', CLEAN_TEXT);

    await new InboundProcessor(store, repo, new FakeBodyStore(), quarantine).process({
      rawKey: 'inbound/CLEAN',
    });

    expect(quarantine.copies).toEqual([]);
    expect(repo.inbound[0]!.failed).toBeUndefined();
    expect(repo.inbound[0]!.quarantineS3Key).toBeUndefined();
  });

  it('tags the raw copy for expiry only AFTER the fully extracted row is committed', async () => {
    const store = new FakeStore();
    const events: string[] = [];
    const repo = new FakeDao();
    const createInbound = repo.createInboundEmail.bind(repo);
    repo.createInboundEmail = (record) => {
      events.push('row');
      return createInbound(record);
    };
    store.onTag = (key) => events.push(`tag:${key}`);
    seed(store, 'TAGGED', CLEAN_TEXT);

    await new InboundProcessor(store, repo, new FakeBodyStore(), new FakeQuarantine()).process({
      rawKey: 'inbound/TAGGED',
    });

    expect(events).toEqual(['row', 'tag:inbound/TAGGED']);
  });

  it('stores an empty inline body for attachment-only mail — never mistaken for legacy', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    seed(
      store,
      'PDFONLY',
      [
        'X-SES-Spam-Verdict: PASS',
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Subject: scan',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="scan.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'SGVsbG8gUERG',
        '',
      ].join('\r\n'),
    );

    await new InboundProcessor(store, repo, new FakeBodyStore(), new FakeQuarantine()).process({
      rawKey: 'inbound/PDFONLY',
    });

    expect(repo.inbound[0]!.body).toEqual({ kind: 'inline' });
    expect(store.taggedKeys).toEqual(['inbound/PDFONLY']);
  });

  it('extracts attachments to a key OUTSIDE inbound/ (no recursive re-trigger)', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    seed(store, 'MSG2', withAttachment('PASS'));
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/MSG2',
    });

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
    const repo = new FakeDao();
    seed(store, 'MSG3', withAttachment('FAIL'));
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/MSG3',
    });

    expect(result.outcome).toBe('quarantined');
    const row = repo.inbound[0]!;
    expect(row.virusVerdict).toBe('FAIL');
    expect(row.quarantined).toBe(true);
    expect(row.hasAttachments).toBe(true);
    expect(row.attachmentCount).toBe(1);
    expect(row.attachments).toEqual([]);
    expect(row.snippet).toBeUndefined();
    expect(row.body).toBeUndefined(); // nothing readable is stored for a non-PASS message
    expect(store.putKeys).toEqual([]); // never materialized the malware
    expect(row.failed).toBe(true);
    expect(row.quarantineS3Key).toBe('inbound/MSG3.eml');
  });

  it('oversize: never downloaded — sender, subject, and verdicts come from its header block', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const quarantine = new FakeQuarantine();
    // HEAD reports a size over the raw cap; only the leading header block is ever read.
    store.heads.set('inbound/BIG', { sizeBytes: 41 * 1024 * 1024, lastModified: RECEIVED });
    store.objects.set('inbound/BIG', `${CLEAN_TEXT}${'x'.repeat(1000)}`);

    const result = await new InboundProcessor(store, repo, new FakeBodyStore(), quarantine).process(
      { rawKey: 'inbound/BIG' },
    );

    expect(result.outcome).toBe('quarantined');
    expect(store.getCalls).toBe(0); // never downloaded
    expect(store.headReads).toEqual([{ key: 'inbound/BIG', maxBytes: MAX_HEADER_BLOCK_BYTES }]);
    const row = repo.inbound[0]!;
    expect(row.parseStatus).toBe('oversize');
    expect(row.from).toBe('a@x.com');
    expect(row.subject).toBe('Hi');
    expect(row.virusVerdict).toBe('PASS'); // SES's real verdict, not ABSENT
    expect(row.quarantined).toBe(true);
    expect(row.attachments).toEqual([]);
    expect(row.body).toBeUndefined();
    // Errors folder: its raw MIME is kept in quarantine.
    expect(row.failed).toBe(true);
    expect(row.quarantineS3Key).toBe('inbound/BIG.eml');
    expect(quarantine.copies).toEqual([{ sourceKey: 'inbound/BIG', destKey: 'inbound/BIG.eml' }]);
  });

  it('oversize with a header block too long to read: ABSENT verdicts, still kept', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    store.heads.set('inbound/HUGEHDR', { sizeBytes: 41 * 1024 * 1024, lastModified: RECEIVED });
    // No blank line inside the bytes read: the header block runs past them.
    store.objects.set('inbound/HUGEHDR', `X-Long: ${'y'.repeat(MAX_HEADER_BLOCK_BYTES)}\r\n\r\n`);

    await new InboundProcessor(store, repo, new FakeBodyStore(), new FakeQuarantine()).process({
      rawKey: 'inbound/HUGEHDR',
    });

    const row = repo.inbound[0]!;
    expect(row.virusVerdict).toBe('ABSENT');
    expect(row.from).toBe('');
    expect(row.failed).toBe(true);
  });

  it('limit breach: quarantines and cleans up attachments written during the failed attempt', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    // One more attachment than the default cap → limit_exceeded after the cap is filled.
    seed(store, 'MANY', manyAttachments(MAX_ATTACHMENTS + 1));
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/MANY',
    });

    expect(result.outcome).toBe('quarantined');
    const row = repo.inbound[0]!;
    expect(row.parseStatus).toBe('limit_exceeded');
    expect(row.attachments).toEqual([]); // no partial publish
    expect(row.body).toBeUndefined();
    expect(row.failed).toBe(true); // clean but unparsed → Errors folder, raw kept in quarantine
    expect(row.quarantineS3Key).toBe('inbound/MANY.eml');
    // Everything written this attempt was cleaned up (and is unreferenced regardless).
    expect(store.putKeys.length).toBeGreaterThan(0);
    expect(store.deletedKeys.sort()).toEqual([...store.putKeys].sort());
  });

  it('duplicate redelivery: the conditional put no-ops → "duplicate"', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    repo.existingIds.add('MSG1');
    seed(store, 'MSG1', CLEAN_TEXT);
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/MSG1',
    });
    expect(result).toEqual({ outcome: 'duplicate', messageId: 'MSG1' });
    // A retry after a failed tag lands here: the raw copy is (re-)tagged all the same.
    expect(store.taggedKeys).toEqual(['inbound/MSG1']);
  });

  it('malformed event key: skipped, never touches S3 or DDB', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/a/b/traversal',
    });
    expect(result.outcome).toBe('skipped');
    expect(store.headCalls).toBe(0);
    expect(repo.inbound).toEqual([]);
  });

  it('missing object: skipped (HEAD returns null)', async () => {
    const store = new FakeStore();
    const repo = new FakeDao();
    const result = await new InboundProcessor(
      store,
      repo,
      new FakeBodyStore(),
      new FakeQuarantine(),
    ).process({
      rawKey: 'inbound/GONE',
    });
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('object not found');
    expect(repo.inbound).toEqual([]);
  });

  it('infra failure (S3 put) propagates as a rejection so the invocation retries', async () => {
    const store = new FakeStore();
    store.putShouldThrow = true;
    const repo = new FakeDao();
    seed(store, 'MSG2', withAttachment('PASS'));
    await expect(
      new InboundProcessor(store, repo, new FakeBodyStore(), new FakeQuarantine()).process({
        rawKey: 'inbound/MSG2',
      }),
    ).rejects.toThrow('s3 put failed');
    expect(repo.inbound).toEqual([]); // no row committed on an infra failure
  });
});
