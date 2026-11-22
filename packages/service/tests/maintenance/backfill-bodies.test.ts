import { Readable } from 'node:stream';
import type { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { EmailsDao, GetEmailOutput, QueryEmailsByDirectionInput, QueryEmailsByDirectionOutput, StoredEmailBody } from '../../src/data/emails-dao.js';
import type { MailBodyContent, MailBodyStore } from '../../src/facades/s3-mail-body-store.js';
import { backfillBodies, type BodyWriter, DdbBodyWriter, type RawMessageSource } from '../../src/maintenance/backfill-bodies.js';
import { buildRawMime } from '../../src/utils/mime.js';

function sentRow(id: string, overrides: Record<string, unknown> = {}): GetEmailOutput {
  return {
    direction: 'sent',
    pk: 'SENT',
    sk: `2026-09-10T00:00:00.000Z#${id}`,
    id,
    from: 'me@example.com',
    to: ['a@b.com'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    sentAt: '2026-09-10T00:00:00.000Z',
    attachmentCount: 0,
    sizeBytes: 100,
    status: 'sent',
    rawS3Key: `sent/${id}`,
    ...overrides,
  } as unknown as GetEmailOutput;
}

function inboundRow(id: string, overrides: Record<string, unknown> = {}): GetEmailOutput {
  return {
    direction: 'inbound',
    pk: 'INBOUND',
    sk: `2026-09-11T00:00:00.000Z#${id}`,
    id,
    from: 'alice@x.com',
    to: ['me@example.com'],
    cc: [],
    subject: 'Hello',
    receivedAt: '2026-09-11T00:00:00.000Z',
    attachmentCount: 0,
    hasAttachments: false,
    sizeBytes: 100,
    rawS3Key: `inbound/${id}`,
    parseStatus: 'ok',
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    quarantined: false,
    ...overrides,
  } as unknown as GetEmailOutput;
}

/** Serves each partition's rows in pages, honouring `afterSk` like the real Query. */
class FakeDao {
  readonly queries: QueryEmailsByDirectionInput[] = [];
  constructor(private readonly rows: GetEmailOutput[]) {}
  queryEmailsByDirection(input: QueryEmailsByDirectionInput): Promise<QueryEmailsByDirectionOutput> {
    this.queries.push(input);
    const partition = this.rows.filter((row) => row.direction === input.direction);
    const start = input.afterSk ? partition.findIndex((r) => r.sk === input.afterSk) + 1 : 0;
    return Promise.resolve({ emails: partition.slice(start, start + input.limit) });
  }
}

class FakeWriter implements BodyWriter {
  readonly writes: { id: string; body: StoredEmailBody }[] = [];
  existing = new Set<string>();
  setBody(row: GetEmailOutput, body: StoredEmailBody): Promise<'set' | 'already_set'> {
    if (this.existing.has(row.id)) {
      return Promise.resolve('already_set');
    }
    this.writes.push({ id: row.id, body });
    return Promise.resolve('set');
  }
}

class FakeRaw implements RawMessageSource {
  readonly objects = new Map<string, Buffer>();
  getStream(key: string): Promise<Readable> {
    const body = this.objects.get(key);
    if (!body) {
      const err = new Error(`no object ${key}`);
      err.name = 'NoSuchKey';
      return Promise.reject(err);
    }
    return Promise.resolve(Readable.from([body]));
  }
}

class FakeBodies implements MailBodyStore {
  readonly puts = new Map<string, MailBodyContent>();
  putBody(key: string, body: MailBodyContent): Promise<void> {
    this.puts.set(key, body);
    return Promise.resolve();
  }
  getBody(): Promise<MailBodyContent | null> {
    return Promise.resolve(null);
  }
}

function receivedMime(text: string, virus = 'PASS'): Buffer {
  return Buffer.from(['X-SES-Spam-Verdict: PASS', `X-SES-Virus-Verdict: ${virus}`, 'From: alice@x.com', 'Subject: Hello', 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n'));
}

async function sentMime(text: string, html?: string): Promise<Buffer> {
  return buildRawMime({ from: 'me@example.com', to: ['a@b.com'], cc: [], bcc: [], subject: 'Hi', text, ...(html ? { html } : {}), attachments: [] });
}

function run(rows: GetEmailOutput[], raw: FakeRaw, apply: boolean, writer = new FakeWriter(), bodies = new FakeBodies()) {
  const lines: string[] = [];
  const promise = backfillBodies({
    emailsDao: new FakeDao(rows) as unknown as EmailsDao,
    writer,
    rawMessages: raw,
    bodies,
    apply,
    log: (line) => lines.push(line),
  });
  return { promise, writer, bodies, lines };
}

describe('backfillBodies', () => {
  it('dry run: reports what it would store, writes nothing', async () => {
    const raw = new FakeRaw();
    raw.objects.set('sent/s1', await sentMime('hello from me'));
    raw.objects.set('inbound/i1', receivedMime('hello from alice'));
    const backfill = run([sentRow('s1'), inboundRow('i1')], raw, false);

    const report = await backfill.promise;

    expect(report.outcomes.would_backfill).toBe(2);
    expect(backfill.writer.writes).toEqual([]);
    expect(backfill.bodies.puts.size).toBe(0);
  });

  it('apply: stores the re-parsed body inline on sent and received rows', async () => {
    const raw = new FakeRaw();
    raw.objects.set('sent/s1', await sentMime('hello from me', '<p>hello from me</p>'));
    raw.objects.set('inbound/i1', receivedMime('hello from alice'));
    const backfill = run([sentRow('s1'), inboundRow('i1')], raw, true);

    const report = await backfill.promise;

    expect(report.outcomes.backfilled).toBe(2);
    const byId = new Map(backfill.writer.writes.map((w) => [w.id, w.body]));
    expect(byId.get('s1')).toMatchObject({ kind: 'inline', html: '<p>hello from me</p>' });
    expect((byId.get('s1') as { text?: string }).text).toContain('hello from me');
    expect(byId.get('i1')).toMatchObject({ kind: 'inline' });
    expect((byId.get('i1') as { text?: string }).text).toContain('hello from alice');
  });

  it('apply: a body too large for the row goes to bodies/<direction>/<id>.json first', async () => {
    const raw = new FakeRaw();
    raw.objects.set('inbound/big', receivedMime('x'.repeat(300 * 1024)));
    const backfill = run([inboundRow('big')], raw, true);

    await backfill.promise;

    expect(backfill.writer.writes).toEqual([{ id: 'big', body: { kind: 's3', s3Key: 'bodies/inbound/big.json' } }]);
    expect(backfill.bodies.puts.get('bodies/inbound/big.json')?.text?.length).toBeGreaterThan(256 * 1024);
  });

  it('leaves rows that already have a body alone, and never re-reads their raw MIME', async () => {
    const raw = new FakeRaw();
    const backfill = run([sentRow('s1', { body: { kind: 'inline', text: 'stored' } }), inboundRow('i1', { body: { kind: 'inline', text: 'stored' } })], raw, true);

    const report = await backfill.promise;

    expect(report.outcomes.has_body).toBe(2);
    expect(backfill.writer.writes).toEqual([]);
  });

  it('skips received mail whose stored verdicts expose no content, without reading it', async () => {
    const raw = new FakeRaw();
    const backfill = run([inboundRow('v1', { virusVerdict: 'FAIL' }), inboundRow('p1', { parseStatus: 'parse_failed' })], raw, true);

    const report = await backfill.promise;

    expect(report.outcomes.not_exposable).toBe(2);
    expect(backfill.writer.writes).toEqual([]);
  });

  it('skips a message whose re-parse exposes nothing (fail closed on the raw verdicts too)', async () => {
    const raw = new FakeRaw();
    raw.objects.set('inbound/i1', receivedMime('infected', 'FAIL'));
    const backfill = run([inboundRow('i1')], raw, true);

    expect((await backfill.promise).outcomes.not_exposable).toBe(1);
    expect(backfill.writer.writes).toEqual([]);
  });

  it('reports a sent row with no archive and a received row whose raw MIME is gone', async () => {
    const backfill = run([sentRow('s0', { rawS3Key: undefined }), inboundRow('gone')], new FakeRaw(), true);

    const report = await backfill.promise;

    expect(report.outcomes.no_archive).toBe(1);
    expect(report.outcomes.raw_missing).toBe(1);
    expect(backfill.writer.writes).toEqual([]);
  });

  it('counts a body another run stored first as already there', async () => {
    const raw = new FakeRaw();
    raw.objects.set('sent/s1', await sentMime('hi'));
    const writer = new FakeWriter();
    writer.existing.add('s1');

    const report = await run([sentRow('s1')], raw, true, writer).promise;

    expect(report.outcomes.has_body).toBe(1);
    expect(report.outcomes.backfilled).toBe(0);
  });

  it('pages through both partitions', async () => {
    const raw = new FakeRaw();
    const rows = Array.from({ length: 150 }, (_, i) => sentRow(`s${String(i).padStart(3, '0')}`, { body: { kind: 'inline', text: '' } }));
    const dao = new FakeDao([...rows, inboundRow('i1', { body: { kind: 'inline', text: '' } })]);

    const report = await backfillBodies({ emailsDao: dao as unknown as EmailsDao, writer: new FakeWriter(), rawMessages: raw, bodies: new FakeBodies(), apply: false, log: () => undefined });

    expect(report.scanned).toBe(151);
    expect(dao.queries.map((q) => q.direction)).toEqual(['sent', 'sent', 'inbound']);
  });

  it('surveys the other legacy data: unrecorded sent attachments and old linked uploads', async () => {
    const body = { kind: 'inline', text: '' };
    const rows = [
      sentRow('needs-descriptors', { body, attachmentCount: 2 }),
      sentRow('linked', {
        body,
        attachmentCount: 1,
        attachments: [{ id: '0', filename: 'big.zip', contentType: 'application/zip', sizeBytes: 9, s3Key: 'attachments/outbound/linked/0' }],
      }),
      sentRow('modern', { body, attachmentCount: 1, attachments: [{ id: '0', filename: 'a.txt', contentType: 'text/plain', sizeBytes: 1, s3Key: 'attachments/sent/modern/0' }] }),
    ];

    const report = await run(rows, new FakeRaw(), false).promise;

    expect(report.sentAttachmentsUnrecorded).toEqual(['needs-descriptors']);
    expect(report.legacyLinkedAttachments).toEqual(['linked']);
  });
});

describe('DdbBodyWriter', () => {
  function writer(fail?: Error) {
    const sent: UpdateCommand[] = [];
    const doc = {
      send: (command: UpdateCommand) => {
        sent.push(command);
        return fail ? Promise.reject(fail) : Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    return { sent, writer: new DdbBodyWriter(doc, 'emails') };
  }

  it('sets the body on the row’s own key, only if the row exists and has none', async () => {
    const harness = writer();
    expect(await harness.writer.setBody(inboundRow('i1'), { kind: 'inline', text: 'hi' })).toBe('set');
    const input = harness.sent[0]!.input;
    expect(input.Key).toEqual({ pk: 'INBOUND', sk: '2026-09-11T00:00:00.000Z#i1' });
    expect(input.ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(#body)');
    expect(input.ExpressionAttributeValues).toEqual({ ':body': { kind: 'inline', text: 'hi' } });
  });

  it('keys a sent row by its send time', async () => {
    const harness = writer();
    await harness.writer.setBody(sentRow('s1'), { kind: 'inline', text: 'hi' });
    expect(harness.sent[0]!.input.Key).toEqual({ pk: 'SENT', sk: '2026-09-10T00:00:00.000Z#s1' });
  });

  it('reports a body already there (condition failed) rather than throwing', async () => {
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    expect(await writer(err).writer.setBody(sentRow('s1'), { kind: 'inline', text: 'hi' })).toBe('already_set');
  });

  it('rethrows anything else', async () => {
    await expect(writer(new Error('boom')).writer.setBody(sentRow('s1'), { kind: 'inline' })).rejects.toThrow('boom');
  });
});
