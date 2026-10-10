import { Readable } from 'node:stream';
import { MAX_EMAIL_RESPONSE_BYTES, MAX_READ_BODY_BYTES } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import {
  type CreateInboundEmailOutput,
  type CreateSentEmailOutput,
  type EmailsDao,
  INBOUND_PARTITION,
  SENT_PARTITION,
  type GetEmailOutput,
  type QueryEmailsByDirectionInput,
  type QueryEmailsByDirectionOutput,
  type UpdateSentEmailStatusOutput,
} from '../../src/data/emails-dao.js';
import type {
  AttachmentPresigner,
  PresignRequest,
} from '../../src/facades/s3-attachment-presigner.js';
import type { ParsedInbound } from '../../src/utils/inbound-parse.js';
import { EmailError } from '../../src/utils/errors.js';
import { encodeEmailRef } from '../../src/utils/email-ref.js';
import {
  EmailReadService,
  type ParseInbound,
  type RawMimeSource,
} from '../../src/services/email-read-service.js';

function sentRow(overrides: Partial<GetEmailOutput & { direction: 'sent' }> = {}): GetEmailOutput {
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
  } as GetEmailOutput;
}

const SENT_ATTACHMENTS = [
  {
    id: '0',
    filename: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 12,
    s3Key: 'attachments/sent/s1/0',
  },
  {
    id: '1',
    filename: 'big.zip',
    contentType: 'application/zip',
    sizeBytes: 5_000_000,
    s3Key: 'attachments/outbound/s1/0',
  },
];

function inboundRow(
  overrides: Partial<GetEmailOutput & { direction: 'inbound' }> = {},
): GetEmailOutput {
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
  } as GetEmailOutput;
}

class FakeDao implements EmailsDao {
  private readonly byKey = new Map<string, GetEmailOutput>();
  queryImpl: (direction: QueryEmailsByDirectionInput['direction']) => Promise<GetEmailOutput[]> =
    () => Promise.resolve([]);

  put(pk: string, row: GetEmailOutput): string {
    this.byKey.set(`${pk}|${row.sk}`, row);
    return encodeEmailRef({ pk, sk: row.sk });
  }
  createSentEmail(): Promise<CreateSentEmailOutput> {
    return Promise.resolve({});
  }
  updateSentEmailStatus(): Promise<UpdateSentEmailStatusOutput> {
    return Promise.resolve({});
  }
  createInboundEmail(): Promise<CreateInboundEmailOutput> {
    return Promise.resolve({ created: true });
  }
  getEmail(key: { pk: string; sk: string }): Promise<GetEmailOutput | null> {
    return Promise.resolve(this.byKey.get(`${key.pk}|${key.sk}`) ?? null);
  }
  queryEmailsByDirection(
    input: QueryEmailsByDirectionInput,
  ): Promise<QueryEmailsByDirectionOutput> {
    return this.queryImpl(input.direction).then((emails) => ({ emails }));
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
  calls: Array<{ sink: unknown; limits: unknown; options: unknown }>;
} {
  const calls: Array<{ sink: unknown; limits: unknown; options: unknown }> = [];
  const fn: ParseInbound = (_source, sink, limits, options) => {
    calls.push({ sink, limits, options });
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
  repo: FakeDao,
  presigner: FakePresigner,
  rawMime: FakeRawMime,
  parse?: ParseInbound,
): EmailReadService {
  return new EmailReadService({
    emailsDao: repo,
    presigner,
    rawMime,
    now: NOW,
    ...(parse ? { parse } : {}),
  });
}

describe('EmailReadService.getEmail', () => {
  it('legacy sent row (no archive) → envelope-only, no body, no re-parse, bcc present', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    // A pre-#29 sent row has no rawS3Key/status.
    const handle = repo.put(SENT_PARTITION, sentRow());
    const detail = await service(repo, new FakePresigner(), rawMime).getEmail({ handle: handle });

    expect(detail.direction).toBe('sent');
    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.status).toBeUndefined();
    expect(detail.attachments).toEqual([]);
    expect(detail.bcc).toEqual(['secret@e.com']);
    // No archive → never re-parses.
    expect(rawMime.getStreamCalls).toEqual([]);
  });

  it('sent with archive (#29) → materializes body via assumeExposed, skips the verdict gate, surfaces status', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const parser = fakeParse({ textBody: 'my sent body', htmlBody: '<p>sent</p>' });
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ rawS3Key: 'sent/s1', status: 'sent' } as Partial<GetEmailOutput>),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });

    expect(detail.text).toBe('my sent body');
    expect(detail.html).toBe('<p>sent</p>');
    expect(detail.status).toBe('sent');
    expect(detail.attachments).toEqual([]);
    // Re-parses the sent archive, forcing exposure (no verdict headers on our own MIME).
    expect(rawMime.getStreamCalls).toEqual(['sent/s1']);
    expect(parser.calls).toHaveLength(1);
    expect(parser.calls[0].options).toEqual({ assumeExposed: true });
    expect(
      (parser.calls[0].limits as { maxSnippetSourceBytes: number }).maxSnippetSourceBytes,
    ).toBe(MAX_READ_BODY_BYTES);
  });

  it('sent row with recorded attachments → lists them WITHOUT the S3 key', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ attachments: SENT_ATTACHMENTS } as Partial<GetEmailOutput>),
    );
    const detail = await service(repo, new FakePresigner(), new FakeRawMime()).getEmail({
      handle,
    });
    expect(detail.attachments).toEqual([
      { id: '0', filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 12 },
      { id: '1', filename: 'big.zip', contentType: 'application/zip', sizeBytes: 5_000_000 },
    ]);
    expect(JSON.stringify(detail)).not.toContain('attachments/');
  });

  it('sent archive that fails to re-parse (exposed:false) → envelope-only, no throw', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    // A corrupt archive → parseInbound resolves with exposed:false; the reader falls back.
    const parser = fakeParse({ parseStatus: 'parse_failed', exposed: false });
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ rawS3Key: 'sent/s1', status: 'sent' } as Partial<GetEmailOutput>),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });
    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.status).toBe('sent');
  });

  it('send_failed sent row → status surfaced, body materialized from the archive', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const parser = fakeParse({ textBody: 'the message we tried to send' });
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ rawS3Key: 'sent/s1', status: 'send_failed' } as Partial<GetEmailOutput>),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });
    expect(detail.status).toBe('send_failed');
    expect(detail.text).toBe('the message we tried to send');
  });

  it('materializes a real SENT body end-to-end through parseInbound despite NO verdict headers', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    // Our own composed MIME has no X-SES-*-Verdict headers — assumeExposed must still yield a body.
    rawMime.streams.set(
      'sent/s1',
      [
        'From: me@mydomain.com',
        'To: a@b.com',
        'Subject: My sent message',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>This is what I sent</p>',
        '',
      ].join('\r\n'),
    );
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ rawS3Key: 'sent/s1', status: 'sent' } as Partial<GetEmailOutput>),
    );

    // No injected parse → uses the real parseInbound with the sent (assumeExposed) branch.
    const detail = await service(repo, new FakePresigner(), rawMime).getEmail({ handle: handle });
    expect(detail.html).toContain('This is what I sent');
  });

  it('inbound exposable → materializes body; attachments exposed WITHOUT the S3 key', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    const parser = fakeParse({ textBody: 'plain body', htmlBody: '<p>body</p>' });

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });

    expect(detail.text).toBe('plain body');
    expect(detail.html).toBe('<p>body</p>');
    expect(rawMime.getStreamCalls).toEqual(['inbound/i1']);
    // Re-parse uses the no-op sink and the read limits (full body retention).
    expect(parser.calls).toHaveLength(1);
    expect(
      (parser.calls[0].limits as { maxSnippetSourceBytes: number }).maxSnippetSourceBytes,
    ).toBe(MAX_READ_BODY_BYTES);
    // The S3 key is stripped from the public descriptor.
    expect(detail.attachments).toEqual([
      { id: '0', filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 9 },
    ]);
    expect(JSON.stringify(detail)).not.toContain('attachments/inbound');
  });

  it('virus/parse-quarantined → metadata-only and NEVER re-parses', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const parser = fakeParse({});
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

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });

    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.quarantined).toBe(true);
    expect(detail.attachments).toEqual([]);
    // Gated on the STORED verdicts — no raw fetch, no parse.
    expect(rawMime.getStreamCalls).toEqual([]);
    expect(parser.calls).toHaveLength(0);
  });

  it('spam-quarantined (virus PASS, parse ok) → viewable-but-hidden: body materialized, quarantined:true', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const parser = fakeParse({ htmlBody: '<p>spammy</p>' });
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({ spamVerdict: 'FAIL', quarantined: true }),
    );

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });

    expect(detail.quarantined).toBe(true);
    expect(detail.html).toBe('<p>spammy</p>');
    expect(rawMime.getStreamCalls).toEqual(['inbound/i1']);
  });

  it('flags bodyTruncated when a body part exceeds the read cap', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    const parser = fakeParse({ htmlBody: 'x'.repeat(MAX_READ_BODY_BYTES + 100) });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });
    expect(detail.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(detail.html ?? '', 'utf8')).toBeLessThanOrEqual(MAX_READ_BODY_BYTES);
  });

  it('keeps the whole response under the Lambda budget for a pathological (JSON-inflating) body', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    // Control chars each JSON-escape to \u00XX (6×); a naive char-count cap would blow 6 MB.
    const dense = '\x01'.repeat(3 * 1024 * 1024);
    const parser = fakeParse({ textBody: dense, htmlBody: dense });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });
    const responseBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
    // Envelope + body combined stays under the whole-response ceiling.
    expect(responseBytes).toBeLessThanOrEqual(MAX_EMAIL_RESPONSE_BYTES);
    expect(detail.bodyTruncated).toBe(true);
  });

  it('byte-truncates a combined multibyte text+html body (under the char count, over the byte budget)', async () => {
    const repo = new FakeDao();
    const rawMime = new FakeRawMime();
    // Each part is well under a naive 1M-CHARACTER cap but far over the 1 MB BYTE cap:
    // '中' = 3 UTF-8 bytes (1.2 MB), '😀' = 4 UTF-8 bytes over 2 code units (1.2 MB).
    const parser = fakeParse({
      textBody: '中'.repeat(400_000),
      htmlBody: '😀'.repeat(300_000),
    });
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const detail = await service(repo, new FakePresigner(), rawMime, parser.fn).getEmail({
      handle: handle,
    });
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
    const repo = new FakeDao();
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
    const detail = await service(repo, new FakePresigner(), rawMime).getEmail({ handle: handle });
    expect(detail.html).toContain('Hi there');
  });

  it('missing row → not_found', async () => {
    const repo = new FakeDao();
    const handle = encodeEmailRef({ pk: INBOUND_PARTITION, sk: '2026-07-17T10:00:00.000Z#nope' });
    await expect(
      service(repo, new FakePresigner(), new FakeRawMime()).getEmail({ handle: handle }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('EmailReadService.getAttachmentUrl', () => {
  it('presigns the descriptor s3Key as a forced non-inline download', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const result = await service(repo, presigner, new FakeRawMime()).getAttachmentUrl({
      handle,
      attachmentId: '0',
    });

    expect(result.url).toBe(presigner.url);
    expect(result.expiresAt).toBe('2026-07-17T12:01:00.000Z'); // now + 60s
    expect(presigner.last?.key).toBe('attachments/inbound/i1/0');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="r\.pdf"/);
    expect(presigner.last?.expiresInSeconds).toBe(60);
  });

  it('unknown attachment id → not_found (no presign)', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    await expect(
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl({ handle, attachmentId: '99' }),
    ).rejects.toBeInstanceOf(EmailError);
    expect(presigner.last).toBeUndefined();
  });

  it('quarantined inbound (no descriptors) → not_found, never a guessable key', async () => {
    const repo = new FakeDao();
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
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl({ handle, attachmentId: '0' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('sent row written before attachments were recorded → not_found (no descriptors)', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow());
    await expect(
      service(repo, presigner, new FakeRawMime()).getAttachmentUrl({ handle, attachmentId: '0' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('sent message → presigns its stored descriptor (embedded copy or linked upload)', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ attachments: SENT_ATTACHMENTS } as Partial<GetEmailOutput>),
    );

    await service(repo, presigner, new FakeRawMime()).getAttachmentUrl({
      handle,
      attachmentId: '1',
    });

    expect(presigner.last?.key).toBe('attachments/outbound/s1/0');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="big\.zip"/);
  });
});

describe('EmailReadService.getRawUrl', () => {
  it('presigns a sent archive as a forced <subject>.eml download', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({ rawS3Key: 'sent/s1', status: 'sent' } as Partial<GetEmailOutput>),
    );

    const result = await service(repo, presigner, new FakeRawMime()).getRawUrl({ handle });

    expect(result).toEqual({ url: presigner.url, expiresAt: '2026-07-17T12:01:00.000Z' });
    expect(presigner.last?.key).toBe('sent/s1');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="Sent hi\.eml"/);
    expect(presigner.last?.expiresInSeconds).toBe(60);
  });

  it('presigns a received message that passed the virus scan, even if spam-flagged', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({ spamVerdict: 'FAIL', quarantined: true }),
    );

    await service(repo, presigner, new FakeRawMime()).getRawUrl({ handle });

    expect(presigner.last?.key).toBe('inbound/i1');
  });

  it.each(['FAIL', 'GRAY', 'PROCESSING_FAILED', 'ABSENT', 'UNKNOWN'] as const)(
    'refuses a received message with virus verdict %s → not_found, never presigned',
    async (virusVerdict) => {
      const repo = new FakeDao();
      const presigner = new FakePresigner();
      const handle = repo.put(INBOUND_PARTITION, inboundRow({ virusVerdict, quarantined: true }));

      await expect(
        service(repo, presigner, new FakeRawMime()).getRawUrl({ handle }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(presigner.last).toBeUndefined();
    },
  );

  it('refuses a sent row without an archive → not_found', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow());
    await expect(
      service(repo, presigner, new FakeRawMime()).getRawUrl({ handle }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('names the file safely: unsafe chars replaced, long subjects capped, empty → message.eml', async () => {
    const cases: [string, RegExp][] = [
      ['Q3: plan/v2 <draft>?', /filename="Q3_ plan_v2 _draft__\.eml"/],
      ['', /filename="message\.eml"/],
      ['x'.repeat(200), new RegExp(`filename="${'x'.repeat(80)}\\.eml"`)],
    ];
    for (const [subject, expected] of cases) {
      const repo = new FakeDao();
      const presigner = new FakePresigner();
      const handle = repo.put(
        SENT_PARTITION,
        sentRow({ subject, rawS3Key: 'sent/s1' } as Partial<GetEmailOutput>),
      );
      await service(repo, presigner, new FakeRawMime()).getRawUrl({ handle });
      expect(presigner.last?.contentDisposition).toMatch(expected);
    }
  });

  it('reports rawAvailable on the detail to match what getRawUrl allows', async () => {
    const repo = new FakeDao();
    const read = service(repo, new FakePresigner(), new FakeRawMime());
    const legacySent = repo.put(SENT_PARTITION, sentRow());
    const virusFailed = repo.put(
      INBOUND_PARTITION,
      inboundRow({ virusVerdict: 'FAIL', quarantined: true, attachments: [] }),
    );
    const clean = repo.put(INBOUND_PARTITION, { ...inboundRow(), sk: 'other#i2' });

    expect((await read.getEmail({ handle: legacySent })).rawAvailable).toBe(false);
    expect((await read.getEmail({ handle: virusFailed })).rawAvailable).toBe(false);
    expect((await read.getEmail({ handle: clean })).rawAvailable).toBe(true);
  });
});

describe('EmailReadService.listEmails', () => {
  it('maps rows to list items, strips S3 keys, passes the cursor through', async () => {
    const repo = new FakeDao();
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

  it('surfaces sent status on the list item; a legacy sent row omits it', async () => {
    const repo = new FakeDao();
    repo.queryImpl = (direction) =>
      Promise.resolve(
        direction === 'sent'
          ? [
              sentRow({ status: 'send_failed' } as Partial<GetEmailOutput>),
              sentRow({
                sk: '2026-07-17T08:00:00.000Z#s0',
                sentAt: '2026-07-17T08:00:00.000Z',
                id: 's0',
              } as Partial<GetEmailOutput>),
            ]
          : [],
      );

    const page = await service(repo, new FakePresigner(), new FakeRawMime()).listEmails({
      limit: 25,
      direction: 'sent',
    });

    expect(page.emails[0].status).toBe('send_failed');
    // Legacy row (no status attribute) omits the field rather than inventing one.
    expect(page.emails[1].status).toBeUndefined();
  });
});
