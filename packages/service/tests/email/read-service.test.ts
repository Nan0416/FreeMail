import { Readable } from 'node:stream';
import { MAX_EMAIL_RESPONSE_BYTES, MAX_READ_BODY_BYTES } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import {
  type EmailsReadRepo,
  INBOUND_PARTITION,
  SENT_PARTITION,
  type StoredEmailRow,
} from '../../src/data/emails-repo.js';
import type {
  AttachmentPresigner,
  PresignRequest,
} from '../../src/data/s3-attachment-presigner.js';
import type { ParsedInbound } from '../../src/inbound/parse.js';
import { EmailError } from '../../src/email/errors.js';
import { encodeEmailRef } from '../../src/email/email-ref.js';
import {
  EmailReadService,
  type ParseInbound,
  type RawMimeSource,
} from '../../src/email/read-service.js';

function sentRow(overrides: Partial<StoredEmailRow & { direction: 'sent' }> = {}): StoredEmailRow {
  return {
    direction: 'sent',
    sk: '2026-07-17T09:00:00.000Z#s1',
    id: 's1',
    from: 'me@mydomain.com',
    to: ['a@b.com'],
    cc: ['c@d.com'],
    bcc: ['secret@e.com'],
    subject: 'Sent hi',
    sesMessageId: 'ses-s1',
    sentAt: '2026-07-17T09:00:00.000Z',
    attachmentCount: 2,
    sizeBytes: 1234,
    ...overrides,
  } as StoredEmailRow;
}

function inboundRow(
  overrides: Partial<StoredEmailRow & { direction: 'inbound' }> = {},
): StoredEmailRow {
  return {
    direction: 'inbound',
    sk: '2026-07-17T10:00:00.000Z#i1',
    id: 'i1',
    sesMessageId: 'i1',
    from: 'them@x.com',
    fromName: 'Them',
    to: ['me@mydomain.com'],
    cc: [],
    subject: 'Inbound hi',
    snippet: 'a preview',
    receivedAt: '2026-07-17T10:00:00.000Z',
    headerDate: '2026-07-17T09:59:00.000Z',
    hasAttachments: true,
    attachmentCount: 1,
    attachments: [
      {
        id: '0',
        filename: 'r.pdf',
        contentType: 'application/pdf',
        sizeBytes: 9,
        s3Key: 'attachments/inbound/i1/0',
      },
    ],
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: 'inbound/i1',
    sizeBytes: 2048,
    ...overrides,
  } as StoredEmailRow;
}

class FakeRepo implements EmailsReadRepo {
  private readonly byKey = new Map<string, StoredEmailRow>();
  queryImpl: EmailsReadRepo['queryDirection'] = () => Promise.resolve([]);

  put(pk: string, row: StoredEmailRow): string {
    this.byKey.set(`${pk}|${row.sk}`, row);
    return encodeEmailRef({ pk, sk: row.sk });
  }
  getByKey(key: { pk: string; sk: string }): Promise<StoredEmailRow | null> {
    return Promise.resolve(this.byKey.get(`${key.pk}|${key.sk}`) ?? null);
  }
  queryDirection(
    direction: 'sent' | 'inbound',
    opts: { limit: number; afterSk?: string },
  ): Promise<StoredEmailRow[]> {
    return this.queryImpl(direction, opts);
  }
}

class FakePresigner implements AttachmentPresigner {
  last?: PresignRequest;
  url = 'https://s3.example/presigned?x=1';
  presign(req: PresignRequest): Promise<string> {
    this.last = req;
    return Promise.resolve(this.url);
  }
}

class FakeRawMime implements RawMimeSource {
  readonly streams = new Map<string, string>();
  readonly getStreamCalls: string[] = [];
  getStream(key: string): Promise<Readable> {
    this.getStreamCalls.push(key);
    return Promise.resolve(Readable.from(this.streams.get(key) ?? ''));
  }
}

function fakeParse(result: Partial<ParsedInbound>): {
  fn: ParseInbound;
  calls: Array<{ sink: unknown; limits: unknown }>;
} {
  const calls: Array<{ sink: unknown; limits: unknown }> = [];
  const fn: ParseInbound = (_source, sink, limits) => {
    calls.push({ sink, limits });
    return Promise.resolve({
      parseStatus: 'ok',
      from: '',
      to: [],
      cc: [],
      subject: '',
      verdicts: { spamVerdict: 'PASS', virusVerdict: 'PASS' },
      exposed: true,
      attachmentCount: 0,
      attachments: [],
      ...result,
    } as ParsedInbound);
  };
  return { fn, calls };
}

const NOW = () => new Date('2026-07-17T12:00:00.000Z');

function service(
  repo: FakeRepo,
  presigner: FakePresigner,
  rawMime: FakeRawMime,
  parse?: ParseInbound,
): EmailReadService {
  return new EmailReadService({
    emails: repo,
    presigner,
    rawMime,
    now: NOW,
    ...(parse ? { parse } : {}),
  });
}

describe('EmailReadService.getEmail', () => {
  it('sent → envelope-only, no body, no attachments, bcc present', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    const handle = repo.put(SENT_PARTITION, sentRow());
    const detail = await service(repo, new FakePresigner(), rawMime).getEmail(handle);

    expect(detail.direction).toBe('sent');
    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.attachments).toEqual([]);
    expect(detail.bcc).toEqual(['secret@e.com']);
    // Never re-parses a sent message (no raw source).
    expect(rawMime.getStreamCalls).toEqual([]);
  });

  it('inbound exposable → materializes body; attachments exposed WITHOUT the S3 key', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    const { fn, calls } = fakeParse({ textBody: 'plain body', htmlBody: '<p>body</p>' });

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);

    expect(detail.text).toBe('plain body');
    expect(detail.html).toBe('<p>body</p>');
    expect(rawMime.getStreamCalls).toEqual(['inbound/i1']);
    // Re-parse uses the no-op sink and the read limits (full body retention).
    expect(calls).toHaveLength(1);
    expect((calls[0].limits as { maxSnippetSourceBytes: number }).maxSnippetSourceBytes).toBe(
      MAX_READ_BODY_BYTES,
    );
    // The S3 key is stripped from the public descriptor.
    expect(detail.attachments).toEqual([
      { id: '0', filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 9 },
    ]);
    expect(JSON.stringify(detail)).not.toContain('attachments/inbound');
  });

  it('virus/parse-quarantined → metadata-only and NEVER re-parses', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    const { fn, calls } = fakeParse({});
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        virusVerdict: 'FAIL',
        quarantined: true,
        snippet: undefined,
        attachments: [],
        hasAttachments: false,
      }),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);

    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.quarantined).toBe(true);
    expect(detail.attachments).toEqual([]);
    // Gated on the STORED verdicts — no raw fetch, no parse.
    expect(rawMime.getStreamCalls).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('spam-quarantined (virus PASS, parse ok) → viewable-but-hidden: body materialized, quarantined:true', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    const { fn } = fakeParse({ htmlBody: '<p>spammy</p>' });
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({ spamVerdict: 'FAIL', quarantined: true }),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);

    expect(detail.quarantined).toBe(true);
    expect(detail.html).toBe('<p>spammy</p>');
    expect(rawMime.getStreamCalls).toEqual(['inbound/i1']);
  });

  it('flags bodyTruncated when a body part exceeds the read cap', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    const { fn } = fakeParse({ htmlBody: 'x'.repeat(MAX_READ_BODY_BYTES + 100) });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);
    expect(detail.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(detail.html ?? '', 'utf8')).toBeLessThanOrEqual(MAX_READ_BODY_BYTES);
  });

  it('keeps the whole response under the Lambda budget for a pathological (JSON-inflating) body', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    // Control chars each JSON-escape to \u00XX (6×); a naive char-count cap would blow 6 MB.
    const dense = '\x01'.repeat(3 * 1024 * 1024);
    const { fn } = fakeParse({ textBody: dense, htmlBody: dense });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);
    const responseBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
    // Envelope + body combined stays under the whole-response ceiling.
    expect(responseBytes).toBeLessThanOrEqual(MAX_EMAIL_RESPONSE_BYTES);
    expect(detail.bodyTruncated).toBe(true);
  });

  it('byte-truncates a combined multibyte text+html body (under the char count, over the byte budget)', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    // Each part is well under a naive 1M-CHARACTER cap but far over the 1 MB BYTE cap:
    // '中' = 3 UTF-8 bytes (1.2 MB), '😀' = 4 UTF-8 bytes over 2 code units (1.2 MB).
    const { fn } = fakeParse({
      textBody: '中'.repeat(400_000),
      htmlBody: '😀'.repeat(300_000),
    });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, fn).getEmail(handle);
    expect(detail.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(detail.text ?? '', 'utf8')).toBeLessThanOrEqual(MAX_READ_BODY_BYTES);
    expect(Buffer.byteLength(detail.html ?? '', 'utf8')).toBeLessThanOrEqual(MAX_READ_BODY_BYTES);
    // Truncation never splits a multi-byte char (no replacement char introduced).
    expect(detail.html ?? '').not.toContain('�');
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThanOrEqual(
      MAX_EMAIL_RESPONSE_BYTES,
    );
  });

  it('materializes a real body end-to-end through #10 parseInbound', async () => {
    const repo = new FakeRepo();
    const rawMime = new FakeRawMime();
    rawMime.streams.set(
      'inbound/i1',
      [
        'X-SES-Virus-Verdict: PASS',
        'X-SES-Spam-Verdict: PASS',
        'From: them@example.com',
        'To: me@mydomain.com',
        'Subject: Hello',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Hi there</p>',
        '',
      ].join('\r\n'),
    );
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    // No injected parse → uses the real parseInbound.
    const detail = await service(repo, new FakePresigner(), rawMime).getEmail(handle);
    expect(detail.html).toContain('Hi there');
  });

  it('missing row → not_found', async () => {
    const repo = new FakeRepo();
    const handle = encodeEmailRef({ pk: INBOUND_PARTITION, sk: '2026-07-17T10:00:00.000Z#nope' });
    await expect(
      service(repo, new FakePresigner(), new FakeRawMime()).getEmail(handle),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('EmailReadService.getAttachmentUrl', () => {
  it('presigns the descriptor s3Key as a forced non-inline download', async () => {
    const repo = new FakeRepo();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const result = await service(repo, presigner, new FakeRawMime()).getAttachmentUrl(handle, '0');

    expect(result.url).toBe(presigner.url);
    expect(result.expiresAt).toBe('2026-07-17T12:01:00.000Z'); // now + 60s
    expect(presigner.last?.key).toBe('attachments/inbound/i1/0');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="r\.pdf"/);
    expect(presigner.last?.expiresInSeconds).toBe(60);
  });

  it('unknown attachment id → not_found (no presign)', async () => {
    const repo = new FakeRepo();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    await expect(
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl(handle, '99'),
    ).rejects.toBeInstanceOf(EmailError);
    expect(presigner.last).toBeUndefined();
  });

  it('quarantined inbound (no descriptors) → not_found, never a guessable key', async () => {
    const repo = new FakeRepo();
    const presigner = new FakePresigner();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        virusVerdict: 'FAIL',
        quarantined: true,
        attachments: [],
        hasAttachments: false,
      }),
    );
    await expect(
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl(handle, '0'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('sent message → not_found (no attachment descriptors)', async () => {
    const repo = new FakeRepo();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow());
    await expect(
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl(handle, '0'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('EmailReadService.listEmails', () => {
  it('maps rows to list items, strips S3 keys, passes the cursor through', async () => {
    const repo = new FakeRepo();
    repo.queryImpl = (direction) =>
      Promise.resolve(direction === 'inbound' ? [inboundRow()] : [sentRow()]);

    const page = await service(repo, new FakePresigner(), new FakeRawMime()).listEmails({
      limit: 25,
    });

    expect(page.emails).toHaveLength(2);
    // Newest-first: inbound (10:00) before sent (09:00).
    expect(page.emails[0].direction).toBe('inbound');
    expect(page.emails[1].direction).toBe('sent');
    expect(page.emails.map((e) => e.id).every((id) => typeof id === 'string')).toBe(true);
    expect(JSON.stringify(page.emails)).not.toContain('attachments/inbound');
    // Sent list item carries no inbound-only fields.
    expect(page.emails[1].quarantined).toBeUndefined();
    expect(page.emails[1].snippet).toBeUndefined();
    // Inbound list item surfaces verdicts + quarantined for the UI.
    expect(page.emails[0].quarantined).toBe(false);
    expect(page.emails[0].virusVerdict).toBe('PASS');
  });
});
