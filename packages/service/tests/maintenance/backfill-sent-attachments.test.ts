import { Readable } from 'node:stream';
import type { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type {
  EmailsReadDao,
  GetEmailOutput,
  QueryEmailsByDirectionInput,
  SentAttachmentDescriptor,
} from '../../src/data/emails-dao.js';
import type { OutboundObjectStore } from '../../src/facades/s3-outbound-object-store.js';
import {
  backfillSentAttachments,
  DdbSentAttachmentsWriter,
  type SentAttachmentsWriter,
} from '../../src/maintenance/backfill-sent-attachments.js';
import type { RawMimeSource } from '../../src/services/email-read-service.js';
import { buildRawMime } from '../../src/utils/mime.js';

function sentRow(id: string, overrides: Record<string, unknown> = {}): GetEmailOutput {
  return {
    direction: 'sent',
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
  } as GetEmailOutput;
}

/** Serves `rows` newest-first in pages, honouring `afterSk` like the real Query. */
class FakeDao implements EmailsReadDao {
  constructor(private readonly rows: GetEmailOutput[]) {}
  queryEmailsByDirection({
    limit,
    afterSk,
  }: QueryEmailsByDirectionInput): Promise<GetEmailOutput[]> {
    const start = afterSk ? this.rows.findIndex((r) => r.sk === afterSk) + 1 : 0;
    return Promise.resolve(this.rows.slice(start, start + limit));
  }
  getEmail(): Promise<GetEmailOutput | null> {
    return Promise.resolve(null);
  }
}

class FakeWriter implements SentAttachmentsWriter {
  readonly writes: { id: string; attachments: readonly SentAttachmentDescriptor[] }[] = [];
  setAttachments(
    row: { id: string },
    attachments: readonly SentAttachmentDescriptor[],
  ): Promise<void> {
    this.writes.push({ id: row.id, attachments });
    return Promise.resolve();
  }
}

class FakeStore implements OutboundObjectStore, RawMimeSource {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  put(key: string, body: Buffer): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, body);
    return Promise.resolve();
  }
  getStream(key: string): Promise<Readable> {
    const body = this.objects.get(key);
    if (!body) {
      return Promise.reject(new Error(`no object ${key}`));
    }
    return Promise.resolve(Readable.from([body]));
  }
}

/** Archive a real composed MIME (what EmailService writes) with the given attachments. */
async function archive(
  store: FakeStore,
  id: string,
  attachments: { filename: string; contentType: string; body: string }[],
): Promise<void> {
  const raw = await buildRawMime({
    from: 'me@example.com',
    to: ['a@b.com'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    text: 'see attached',
    attachments: attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: Buffer.from(a.body).toString('base64'),
    })),
  });
  store.objects.set(`sent/${id}`, raw);
}

function run(rows: GetEmailOutput[], store: FakeStore, apply: boolean) {
  const writer = new FakeWriter();
  const lines: string[] = [];
  const promise = backfillSentAttachments({
    emailsDao: new FakeDao(rows),
    writer,
    rawMime: store,
    objectStore: store,
    apply,
    log: (line) => lines.push(line),
  });
  return { promise, writer, lines };
}

const TWO_FILES = [
  { filename: 'notes.txt', contentType: 'text/plain', body: 'hello notes' },
  { filename: 'data.csv', contentType: 'text/csv', body: 'a,b\n1,2\n' },
];

describe('backfillSentAttachments', () => {
  it('dry run: reports what it would record, writes nothing', async () => {
    const store = new FakeStore();
    await archive(store, 's1', TWO_FILES);
    const { promise, writer, lines } = run([sentRow('s1', { attachmentCount: 2 })], store, false);

    const report = await promise;

    expect(report.outcomes.would_backfill).toBe(1);
    expect(writer.writes).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(lines[0]).toContain('notes.txt');
  });

  it('apply: copies each embedded attachment and records descriptors in order', async () => {
    const store = new FakeStore();
    await archive(store, 's1', TWO_FILES);
    const { promise, writer } = run([sentRow('s1', { attachmentCount: 2 })], store, true);

    const report = await promise;

    expect(report.outcomes.backfilled).toBe(1);
    expect(store.objects.get('attachments/sent/s1/0')?.toString()).toBe('hello notes');
    expect(store.objects.get('attachments/sent/s1/1')?.toString()).toBe('a,b\n1,2\n');
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0].attachments).toEqual([
      {
        id: '0',
        filename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: 11,
        s3Key: 'attachments/sent/s1/0',
      },
      {
        id: '1',
        filename: 'data.csv',
        contentType: 'text/csv',
        sizeBytes: 8,
        s3Key: 'attachments/sent/s1/1',
      },
    ]);
  });

  it('skips rows already recorded, without attachments, or without an archive', async () => {
    const store = new FakeStore();
    const { promise, writer } = run(
      [
        sentRow('done', { attachmentCount: 1, attachments: [] }),
        sentRow('plain', { attachmentCount: 0 }),
        sentRow('legacy', { attachmentCount: 1, rawS3Key: undefined }),
      ],
      store,
      true,
    );

    const report = await promise;

    expect(report.scanned).toBe(3);
    expect(report.outcomes).toMatchObject({
      already_recorded: 1,
      no_attachments: 1,
      no_archive: 1,
    });
    expect(writer.writes).toEqual([]);
  });

  it('leaves a row untouched when the archive holds fewer attachments than recorded (a linked one)', async () => {
    const store = new FakeStore();
    await archive(store, 's1', [TWO_FILES[0]]);
    const { promise, writer, lines } = run([sentRow('s1', { attachmentCount: 2 })], store, true);

    const report = await promise;

    expect(report.outcomes.mismatch).toBe(1);
    expect(writer.writes).toEqual([]);
    expect(lines[0]).toMatch(/recorded 2 .* yielded 1/);
  });

  it('pages through the whole SENT partition', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => sentRow(`s${String(i).padStart(3, '0')}`));
    const { promise } = run(rows, new FakeStore(), true);
    expect((await promise).scanned).toBe(250);
  });
});

describe('DdbSentAttachmentsWriter', () => {
  it('sets descriptors on the exact SENT row, only if it exists and has none yet', async () => {
    const commands: UpdateCommand[] = [];
    const doc = {
      send: (command: UpdateCommand) => {
        commands.push(command);
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;

    await new DdbSentAttachmentsWriter(doc, 'emails-test').setAttachments(
      { id: 's1', sentAt: '2026-09-10T00:00:00.000Z' },
      [],
    );

    expect(commands[0].input).toMatchObject({
      TableName: 'emails-test',
      Key: { pk: 'SENT', sk: '2026-09-10T00:00:00.000Z#s1' },
      UpdateExpression: 'SET #attachments = :attachments',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#attachments)',
    });
  });
});
