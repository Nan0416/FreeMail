import { MAX_EMAIL_RESPONSE_BYTES } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import {
  type CreateInboundEmailOutput,
  type CreateSentEmailOutput,
  type EmailsDao,
  type EmailSummary,
  FAILED_PARTITION,
  INBOUND_PARTITION,
  SENT_PARTITION,
  type GetEmailOutput,
  type QueryEmailsByDirectionInput,
  type ListEmailSummariesInput,
  type ListEmailSummariesOutput,
  type QueryEmailsByDirectionOutput,
  type UpdateSentEmailStatusOutput,
} from '../../src/data/emails-dao.js';
import type { AttachmentPresigner, PresignRequest } from '../../src/facades/s3-attachment-presigner.js';
import type { MailBodyContent, MailBodyStore } from '../../src/facades/s3-mail-body-store.js';
import { EmailError } from '../../src/utils/errors.js';
import { decodeEmailRef, encodeEmailRef } from '../../src/utils/email-ref.js';
import { EmailReadService } from '../../src/services/email-read-service.js';

function sentRow(overrides: Partial<GetEmailOutput & { direction: 'sent' }> = {}): GetEmailOutput {
  return {
    direction: 'sent',
    pk: 'SENT',
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
    s3Key: 'attachments/sent/s1/0',
  },
];

function inboundRow(overrides: Partial<GetEmailOutput & { direction: 'inbound' }> = {}): GetEmailOutput {
  return {
    direction: 'inbound',
    pk: 'INBOUND',
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
  queryImpl: (direction: QueryEmailsByDirectionInput['direction']) => Promise<GetEmailOutput[]> = () => Promise.resolve([]);

  put(pk: string, row: GetEmailOutput): string {
    // A stored row always carries the partition it lives in.
    this.byKey.set(`${pk}|${row.sk}`, { ...row, pk });
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
  queryEmailsByDirection(): Promise<QueryEmailsByDirectionOutput> {
    return Promise.resolve({ emails: [] });
  }
  listEmailSummaries(input: ListEmailSummariesInput): Promise<ListEmailSummariesOutput> {
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

class FakeBodyStore implements MailBodyStore {
  readonly bodies = new Map<string, MailBodyContent>();
  readonly getCalls: string[] = [];
  putBody(key: string, body: MailBodyContent): Promise<void> {
    this.bodies.set(key, body);
    return Promise.resolve();
  }
  getBody(key: string): Promise<MailBodyContent | null> {
    this.getCalls.push(key);
    return Promise.resolve(this.bodies.get(key) ?? null);
  }
}

const NOW = () => new Date('2026-07-17T12:00:00.000Z');

function service(repo: FakeDao, presigner: FakePresigner, bodies: FakeBodyStore = new FakeBodyStore(), quarantinePresigner?: FakePresigner): EmailReadService {
  return new EmailReadService({
    emailsDao: repo,
    presigner,
    ...(quarantinePresigner ? { quarantinePresigner } : {}),
    bodies,
    now: NOW,
  });
}

describe('EmailReadService.getEmail', () => {
  it('a row without a stored body → envelope-only (logged), bcc present', async () => {
    const repo = new FakeDao();
    const handle = repo.put(SENT_PARTITION, sentRow());
    const detail = await service(repo, new FakePresigner()).getEmail({ handle: handle });

    expect(detail.direction).toBe('sent');
    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.status).toBeUndefined();
    expect(detail.attachments).toEqual([]);
    expect(detail.bcc).toEqual(['secret@e.com']);
  });

  it('sent row with recorded attachments → lists them WITHOUT the S3 key', async () => {
    const repo = new FakeDao();
    const handle = repo.put(SENT_PARTITION, sentRow({ attachments: SENT_ATTACHMENTS } as Partial<GetEmailOutput>));
    const detail = await service(repo, new FakePresigner()).getEmail({
      handle,
    });
    expect(detail.attachments).toEqual([
      { id: '0', filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 12 },
      { id: '1', filename: 'big.zip', contentType: 'application/zip', sizeBytes: 5_000_000 },
    ]);
    expect(JSON.stringify(detail)).not.toContain('attachments/');
  });

  it('send_failed sent row → status surfaced, stored body shown', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({
        rawS3Key: 'sent/s1',
        status: 'send_failed',
        body: { kind: 'inline', text: 'the message we tried to send' },
      } as Partial<GetEmailOutput>),
    );

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });
    expect(detail.status).toBe('send_failed');
    expect(detail.text).toBe('the message we tried to send');
  });

  it("surfaces a message's Reply-To, and omits it when there is none", async () => {
    const repo = new FakeDao();
    const withReplyTo = repo.put(INBOUND_PARTITION, inboundRow({ sk: '2026-07-17T10:00:00.000Z#r1', id: 'r1', replyTo: ['desk@x.com'] }));
    const without = repo.put(INBOUND_PARTITION, inboundRow());
    const reader = service(repo, new FakePresigner());

    expect((await reader.getEmail({ handle: withReplyTo })).replyTo).toEqual(['desk@x.com']);
    expect((await reader.getEmail({ handle: without })).replyTo).toBeUndefined();
  });

  it('inbound exposable → returns the stored body; attachments exposed WITHOUT the S3 key', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 'inline', text: 'plain body', html: '<p>body</p>' } }));

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });

    expect(detail.text).toBe('plain body');
    expect(detail.html).toBe('<p>body</p>');
    // The S3 key is stripped from the public descriptor.
    expect(detail.attachments).toEqual([{ id: '0', filename: 'r.pdf', contentType: 'application/pdf', sizeBytes: 9 }]);
    expect(JSON.stringify(detail)).not.toContain('attachments/inbound');
  });

  it('virus/parse-quarantined → metadata-only, no body', async () => {
    const repo = new FakeDao();
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

    const detail = await service(repo, new FakePresigner()).getEmail({
      handle: handle,
    });

    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
    expect(detail.quarantined).toBe(true);
    expect(detail.attachments).toEqual([]);
    // Gated on the STORED verdicts — no raw fetch, no parse.
  });

  it('spam-quarantined (virus PASS, parse ok) → viewable-but-hidden: body shown, quarantined:true', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        spamVerdict: 'FAIL',
        quarantined: true,
        body: { kind: 'inline', html: '<p>spammy</p>' },
      }),
    );

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });

    expect(detail.quarantined).toBe(true);
    expect(detail.html).toBe('<p>spammy</p>');
  });

  it('flags bodyTruncated when the body was cut when it was stored', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 'inline', html: 'x'.repeat(100), truncated: true } }));

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });
    expect(detail.bodyTruncated).toBe(true);
  });

  it('keeps the whole response under the Lambda budget for a pathological (JSON-inflating) body', async () => {
    const repo = new FakeDao();
    const bodies = new FakeBodyStore();
    // Control chars each JSON-escape to \u00XX (6×); a naive char-count cap would blow 6 MB.
    const dense = '\x01'.repeat(3 * 1024 * 1024);
    bodies.bodies.set('bodies/inbound/i1.json', { text: dense, html: dense });
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 's3', s3Key: 'bodies/inbound/i1.json' } }));

    const detail = await service(repo, new FakePresigner(), bodies).getEmail({ handle });
    const responseBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
    // Envelope + body combined stays under the whole-response ceiling.
    expect(responseBytes).toBeLessThanOrEqual(MAX_EMAIL_RESPONSE_BYTES);
    expect(detail.bodyTruncated).toBe(true);
  });

  it('byte-truncates a combined multibyte text+html body (under the char count, over the byte budget)', async () => {
    const repo = new FakeDao();
    const bodies = new FakeBodyStore();
    // Together far over the response budget in BYTES, though modest in characters:
    // '中' = 3 UTF-8 bytes, '😀' = 4 UTF-8 bytes over 2 code units.
    bodies.bodies.set('bodies/inbound/i1.json', {
      text: '中'.repeat(1_200_000),
      html: '😀'.repeat(900_000),
    });
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 's3', s3Key: 'bodies/inbound/i1.json' } }));

    const detail = await service(repo, new FakePresigner(), bodies).getEmail({ handle });
    expect(detail.bodyTruncated).toBe(true);
    // Truncation never splits a multi-byte char (no replacement char introduced).
    expect(detail.html ?? '').not.toContain('�');
    expect(detail.text ?? '').not.toContain('�');
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThanOrEqual(MAX_EMAIL_RESPONSE_BYTES);
  });

  it('missing row → not_found', async () => {
    const repo = new FakeDao();
    const handle = encodeEmailRef({ pk: INBOUND_PARTITION, sk: '2026-07-17T10:00:00.000Z#nope' });
    await expect(service(repo, new FakePresigner()).getEmail({ handle: handle })).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('EmailReadService.getAttachmentUrl', () => {
  it('presigns the descriptor s3Key as a forced non-inline download', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const result = await service(repo, presigner).getAttachmentUrl({
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
    await expect(service(repo, presigner).getAttachmentUrl({ handle, attachmentId: '99' })).rejects.toBeInstanceOf(EmailError);
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
    await expect(service(repo, presigner).getAttachmentUrl({ handle, attachmentId: '0' })).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('sent row written before attachments were recorded → not_found (no descriptors)', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow());
    await expect(service(repo, presigner).getAttachmentUrl({ handle, attachmentId: '0' })).rejects.toMatchObject({ code: 'not_found' });
    expect(presigner.last).toBeUndefined();
  });

  it('sent message → presigns its stored descriptor (embedded copy or linked upload)', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow({ attachments: SENT_ATTACHMENTS } as Partial<GetEmailOutput>));

    await service(repo, presigner).getAttachmentUrl({
      handle,
      attachmentId: '1',
    });

    expect(presigner.last?.key).toBe('attachments/sent/s1/0');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="big\.zip"/);
  });
});

describe('EmailReadService.getEmail — stored bodies', () => {
  it('returns an inline stored body without an S3 read', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 'inline', text: 'Stored text', html: '<p>Stored</p>' } }));

    const detail = await service(repo, new FakePresigner()).getEmail({
      handle,
    });

    expect(detail.text).toBe('Stored text');
    expect(detail.html).toBe('<p>Stored</p>');
    expect(detail.bodyTruncated).toBeUndefined();
  });

  it('loads a body stored in S3, still without parsing', async () => {
    const repo = new FakeDao();
    const bodies = new FakeBodyStore();
    bodies.bodies.set('bodies/inbound/i1.json', { html: '<p>Big</p>' });
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 's3', s3Key: 'bodies/inbound/i1.json' } }));

    const detail = await service(repo, new FakePresigner(), bodies).getEmail({
      handle,
    });

    expect(detail.html).toBe('<p>Big</p>');
    expect(bodies.getCalls).toEqual(['bodies/inbound/i1.json']);
  });

  it('reads envelope-only when a stored S3 body is missing (no throw)', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 's3', s3Key: 'bodies/inbound/gone.json' } }));

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });

    expect(detail.text).toBeUndefined();
    expect(detail.html).toBeUndefined();
  });

  it('keeps a body cut at storage time flagged truncated', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ body: { kind: 'inline', text: 'cut', truncated: true } }));

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });

    expect(detail.text).toBe('cut');
    expect(detail.bodyTruncated).toBe(true);
  });

  it('never returns a stored body for a non-exposable inbound row (defense in depth)', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        virusVerdict: 'FAIL',
        quarantined: true,
        body: { kind: 'inline', text: 'should never show' },
      }),
    );

    const detail = await service(repo, new FakePresigner()).getEmail({ handle });

    expect(detail.text).toBeUndefined();
  });

  it('returns the stored body of a sent row instead of re-parsing its archive', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({
        rawS3Key: 'sent/s1',
        status: 'sent',
        body: { kind: 'inline', text: 'As sent' },
      } as Partial<GetEmailOutput>),
    );

    const detail = await service(repo, new FakePresigner()).getEmail({
      handle,
    });

    expect(detail.text).toBe('As sent');
  });
});

describe('EmailReadService — original (.eml) retention window', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function receivedDaysAgo(days: number): string {
    return new Date(NOW().getTime() - days * DAY).toISOString();
  }
  /** A fully extracted row: it has a stored body, so ingest tagged its raw copy to expire. */
  const STORED = { body: { kind: 'inline' as const, text: 'stored' } };

  it('offers the original of fully processed mail inside the 14-day window', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        ...STORED,
        receivedAt: new Date(NOW().getTime() - 14 * DAY + 60_000).toISOString(),
      }),
    );
    const read = service(repo, new FakePresigner());

    expect((await read.getEmail({ handle })).rawAvailable).toBe(true);
    await expect(read.getRawUrl({ handle })).resolves.toHaveProperty('url');
  });

  it('stops offering it once the tagged raw copy has aged out (lifecycle-expired)', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ ...STORED, receivedAt: receivedDaysAgo(14) }));
    const read = service(repo, new FakePresigner());

    expect((await read.getEmail({ handle })).rawAvailable).toBe(false);
    await expect(read.getRawUrl({ handle })).rejects.toBeInstanceOf(EmailError);
  });

  it('keeps offering an untagged raw copy however old — clean mail that failed to parse', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      INBOUND_PARTITION,
      inboundRow({
        parseStatus: 'limit_exceeded',
        attachments: [],
        receivedAt: receivedDaysAgo(30),
      }),
    );

    expect((await service(repo, new FakePresigner()).getEmail({ handle })).rawAvailable).toBe(true);
  });

  it('keeps offering it for a legacy row (no stored body) however old', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ receivedAt: receivedDaysAgo(30) }));

    expect((await service(repo, new FakePresigner()).getEmail({ handle })).rawAvailable).toBe(true);
  });

  it('keeps offering the sent archive however old (it never expires)', async () => {
    const repo = new FakeDao();
    const handle = repo.put(
      SENT_PARTITION,
      sentRow({
        rawS3Key: 'sent/s1',
        sentAt: receivedDaysAgo(400),
      } as Partial<GetEmailOutput>),
    );

    expect((await service(repo, new FakePresigner()).getEmail({ handle })).rawAvailable).toBe(true);
  });
});

describe('EmailReadService.getRawUrl', () => {
  it('presigns a sent archive as a forced <subject>.eml download', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow({ rawS3Key: 'sent/s1', status: 'sent' } as Partial<GetEmailOutput>));

    const result = await service(repo, presigner).getRawUrl({ handle });

    expect(result).toEqual({ url: presigner.url, expiresAt: '2026-07-17T12:01:00.000Z' });
    expect(presigner.last?.key).toBe('sent/s1');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.contentDisposition).toMatch(/^attachment; filename="Sent hi\.eml"/);
    expect(presigner.last?.expiresInSeconds).toBe(60);
  });

  it('presigns a received message that passed the virus scan, even if spam-flagged', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ spamVerdict: 'FAIL', quarantined: true }));

    await service(repo, presigner).getRawUrl({ handle });

    expect(presigner.last?.key).toBe('inbound/i1');
  });

  it.each(['FAIL', 'GRAY', 'PROCESSING_FAILED', 'ABSENT', 'UNKNOWN'] as const)('never offers a fully processed (stored-body) message with virus verdict %s', async (virusVerdict) => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ virusVerdict, quarantined: true, body: { kind: 'inline' } }));

    await expect(service(repo, presigner).getRawUrl({ handle })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(presigner.last).toBeUndefined();
  });

  it.each(['FAIL', 'GRAY', 'ABSENT'] as const)('offers a pre-stored-body message with virus verdict %s — its kept raw copy, flagged suspicious', async (virusVerdict) => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ virusVerdict, quarantined: true }));
    const read = service(repo, presigner);

    const detail = await read.getEmail({ handle });
    expect(detail).toMatchObject({ rawAvailable: true, rawSuspicious: true });
    await read.getRawUrl({ handle });
    expect(presigner.last).toMatchObject({
      key: 'inbound/i1',
      contentType: 'application/octet-stream',
    });
  });

  it('refuses a sent row without an archive → not_found', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(SENT_PARTITION, sentRow());
    await expect(service(repo, presigner).getRawUrl({ handle })).rejects.toMatchObject({
      code: 'not_found',
    });
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
      const handle = repo.put(SENT_PARTITION, sentRow({ subject, rawS3Key: 'sent/s1' } as Partial<GetEmailOutput>));
      await service(repo, presigner).getRawUrl({ handle });
      expect(presigner.last?.contentDisposition).toMatch(expected);
    }
  });

  it('reports rawAvailable on the detail to match what getRawUrl allows', async () => {
    const repo = new FakeDao();
    const read = service(repo, new FakePresigner());
    const legacySent = repo.put(SENT_PARTITION, sentRow());
    const virusFailed = repo.put(INBOUND_PARTITION, inboundRow({ virusVerdict: 'FAIL', quarantined: true, attachments: [] }));
    const clean = repo.put(INBOUND_PARTITION, { ...inboundRow(), sk: 'other#i2' });

    expect((await read.getEmail({ handle: legacySent })).rawAvailable).toBe(false);
    // A pre-stored-body virus-failed row: its kept raw copy is offered, flagged suspicious.
    expect(await read.getEmail({ handle: virusFailed })).toMatchObject({
      rawAvailable: true,
      rawSuspicious: true,
    });
    expect((await read.getEmail({ handle: clean })).rawAvailable).toBe(true);
    expect((await read.getEmail({ handle: clean })).rawSuspicious).toBeUndefined();
  });
});

describe('EmailReadService — Errors folder', () => {
  function failedRow(overrides: Partial<GetEmailOutput & { direction: 'inbound' }> = {}) {
    return inboundRow({
      pk: FAILED_PARTITION,
      virusVerdict: 'FAIL',
      quarantined: true,
      attachments: [],
      snippet: undefined,
      failed: true,
      quarantineS3Key: 'inbound/i1.eml',
      ...overrides,
    } as Partial<GetEmailOutput & { direction: 'inbound' }>);
  }

  it('lists the FAILED partition on request, as inbound rows flagged failed', async () => {
    const repo = new FakeDao();
    const asked: string[] = [];
    repo.queryImpl = (direction) => {
      asked.push(direction);
      return Promise.resolve(direction === 'failed' ? [failedRow({ parseStatus: 'parse_failed' })] : []);
    };

    const page = await service(repo, new FakePresigner()).listEmails({
      direction: 'failed',
      limit: 25,
    });

    expect(asked).toEqual(['failed']);
    expect(page.emails[0]).toMatchObject({
      direction: 'inbound',
      failed: true,
      parseStatus: 'parse_failed',
      virusVerdict: 'FAIL',
    });
    // The handle addresses the FAILED partition, so get_email finds it there.
    const ref = JSON.parse(Buffer.from(page.emails[0]!.id, 'base64url').toString('utf8'));
    expect(ref.pk).toBe(FAILED_PARTITION);
  });

  it('never mixes failed mail into the merged timeline', async () => {
    const repo = new FakeDao();
    const asked: string[] = [];
    repo.queryImpl = (direction) => {
      asked.push(direction);
      return Promise.resolve([]);
    };

    await service(repo, new FakePresigner()).listEmails({ limit: 25 });

    expect(asked.sort()).toEqual(['inbound', 'sent']);
  });

  it('offers a failed message’s quarantined original, flagged suspicious without a virus PASS', async () => {
    const repo = new FakeDao();
    const quarantine = new FakePresigner();
    quarantine.url = 'https://quarantine.example/presigned';
    const handle = repo.put(FAILED_PARTITION, failedRow());
    const read = service(repo, new FakePresigner(), undefined, quarantine);

    const detail = await read.getEmail({ handle });
    expect(detail).toMatchObject({ failed: true, rawAvailable: true, rawSuspicious: true });
    expect(detail.text).toBeUndefined();

    const raw = await read.getRawUrl({ handle });
    expect(raw.url).toBe('https://quarantine.example/presigned');
    expect(quarantine.last).toMatchObject({
      key: 'inbound/i1.eml',
      contentType: 'application/octet-stream',
    });
  });

  it('does not flag a clean-but-unparsed original as suspicious', async () => {
    const repo = new FakeDao();
    const handle = repo.put(FAILED_PARTITION, failedRow({ virusVerdict: 'PASS', parseStatus: 'limit_exceeded' }));

    const detail = await service(repo, new FakePresigner(), undefined, new FakePresigner()).getEmail({ handle });

    expect(detail.rawAvailable).toBe(true);
    expect(detail.rawSuspicious).toBeUndefined();
  });

  it('offers no original where no quarantine presigner is wired (the MCP server)', async () => {
    const repo = new FakeDao();
    const handle = repo.put(FAILED_PARTITION, failedRow());
    const read = service(repo, new FakePresigner());

    expect((await read.getEmail({ handle })).rawAvailable).toBe(false);
    await expect(read.getRawUrl({ handle })).rejects.toBeInstanceOf(EmailError);
  });
});

describe('EmailReadService.listEmails', () => {
  it('maps rows to list items, strips S3 keys, passes the cursor through', async () => {
    const repo = new FakeDao();
    repo.queryImpl = (direction) => Promise.resolve(direction === 'inbound' ? [inboundRow()] : [sentRow()]);

    const page = await service(repo, new FakePresigner()).listEmails({
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

    const page = await service(repo, new FakePresigner()).listEmails({
      limit: 25,
      direction: 'sent',
    });

    expect(page.emails[0].status).toBe('send_failed');
    // Legacy row (no status attribute) omits the field rather than inventing one.
    expect(page.emails[1].status).toBeUndefined();
  });
});

describe('EmailReadService.listEmails — search filters', () => {
  /** `n` inbound rows, newest first, one second apart; every `every`-th one's subject says "match". */
  function inboundRows(n: number, every: number): GetEmailOutput[] {
    return Array.from({ length: n }, (_v, i) => {
      const iso = new Date(Date.UTC(2026, 9, 1, 0, 0, n - i)).toISOString();
      return inboundRow({
        sk: `${iso}#r${i}`,
        id: `r${i}`,
        receivedAt: iso,
        subject: i % every === 0 ? `match ${i}` : `other ${i}`,
      });
    });
  }

  /** A DAO whose list honours limit/afterSk/minSk/maxSk like DynamoDB, and records each call. */
  function scanningDao(rows: GetEmailOutput[]): {
    repo: FakeDao;
    calls: ListEmailSummariesInput[];
  } {
    const repo = new FakeDao();
    const calls: ListEmailSummariesInput[] = [];
    repo.listEmailSummaries = (input) => {
      calls.push(input);
      const inRange = (direction: string) =>
        direction === 'inbound'
          ? rows.filter(
              (row) => (input.afterSk === undefined || row.sk < input.afterSk) && (input.minSk === undefined || row.sk >= input.minSk) && (input.maxSk === undefined || row.sk <= input.maxSk),
            )
          : [];
      return Promise.resolve({
        emails: inRange(input.direction).slice(0, input.limit) as unknown as EmailSummary[],
      });
    };
    return { repo, calls };
  }

  it('returns only matching rows, scanning in batches', async () => {
    const dao = scanningDao(inboundRows(500, 50));
    const reader = service(dao.repo, new FakePresigner());

    const page = await reader.listEmails({
      direction: 'inbound',
      limit: 5,
      filters: { subject: 'MATCH' },
    });

    expect(page.emails.map((e) => e.subject)).toEqual(['match 0', 'match 50', 'match 100', 'match 150', 'match 200']);
    expect(page.nextCursor).toBeDefined();
    // Stopped at the 5th match (row 200), in batches of 200 rows.
    expect(dao.calls.map((c) => c.limit)).toEqual([200, 200]);
  });

  it('stops at the scan budget with a short page and a cursor that skips what it read', async () => {
    const dao = scanningDao(inboundRows(1500, 1200));
    const reader = service(dao.repo, new FakePresigner());

    const first = await reader.listEmails({
      direction: 'inbound',
      limit: 5,
      filters: { subject: 'match' },
    });
    // Row 0 matches; rows 1–999 don't; the budget (1000 rows) ends the page.
    expect(first.emails.map((e) => e.subject)).toEqual(['match 0']);
    expect(dao.calls.reduce((sum, c) => sum + c.limit, 0)).toBe(1000);
    expect(first.nextCursor).toBeDefined();

    const second = await reader.listEmails({
      direction: 'inbound',
      limit: 5,
      cursor: first.nextCursor!,
      filters: { subject: 'match' },
    });
    expect(second.emails.map((e) => e.subject)).toEqual(['match 1200']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('merges filtered matches from both folders newest-first, with a date range, to the end', async () => {
    const inbound = inboundRows(600, 7);
    const sent = Array.from({ length: 600 }, (_v, i) => {
      const iso = new Date(Date.UTC(2026, 9, 1, 0, 0, 600 - i, 500)).toISOString();
      return {
        direction: 'sent',
        pk: 'SENT',
        sk: `${iso}#s${i}`,
        id: `s${i}`,
        from: 'me@mydomain.com',
        to: ['x@y.com'],
        cc: [],
        bcc: [],
        subject: i % 11 === 0 ? `match s${i}` : `other s${i}`,
        sentAt: iso,
        attachmentCount: 0,
        sizeBytes: 1,
      } as GetEmailOutput;
    });
    const repo = new FakeDao();
    repo.listEmailSummaries = (input) => {
      const rows = input.direction === 'sent' ? sent : inbound;
      return Promise.resolve({
        emails: rows
          .filter((row) => (input.afterSk === undefined || row.sk < input.afterSk) && (input.minSk === undefined || row.sk >= input.minSk) && (input.maxSk === undefined || row.sk <= input.maxSk))
          .slice(0, input.limit) as unknown as EmailSummary[],
      });
    };
    const reader = service(repo, new FakePresigner());
    const filters = {
      subject: 'match',
      after: '2026-10-01T00:01:00.000Z',
      before: '2026-10-01T00:08:00.000Z',
    };
    const expected = [...sent, ...inbound]
      .filter((row) => row.subject.startsWith('match') && row.sk >= filters.after && row.sk <= filters.before)
      .map((row) => row.sk)
      .sort()
      .reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await reader.listEmails({
        limit: 7,
        filters,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.emails.map((email) => decodeEmailRef(email.id).sk));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(cursor).toBeUndefined();
    expect(expected.length).toBeGreaterThan(20);
    expect(seen).toEqual(expected);
  });

  it('passes a date range to the query, without scanning, when there is no text filter', async () => {
    const dao = scanningDao(inboundRows(10, 1));
    const reader = service(dao.repo, new FakePresigner());

    await reader.listEmails({
      direction: 'inbound',
      limit: 25,
      filters: { after: '2026-10-01T00:00:03.000Z', before: '2026-10-01T00:00:06.000Z' },
    });

    expect(dao.calls).toEqual([
      {
        direction: 'inbound',
        limit: 25,
        minSk: '2026-10-01T00:00:03.000Z',
        maxSk: '2026-10-01T00:00:06.000Z',
      },
    ]);
  });
});

describe('EmailReadService — delivery reports', () => {
  it("shows a sent message's delivery events once each, in arrival order", async () => {
    const repo = new FakeDao();
    const delivered = {
      type: 'delivered' as const,
      at: '2026-07-17T10:00:03.000Z',
      recipients: ['a@x.com'],
    };
    const bounced = {
      type: 'bounced' as const,
      at: '2026-07-17T10:00:04.000Z',
      recipients: ['b@x.com'],
      detail: 'Permanent/General',
    };
    const handle = repo.put(SENT_PARTITION, {
      ...sentRow(),
      status: 'bounced',
      deliveryEvents: [delivered, bounced, delivered],
    } as GetEmailOutput);

    const detail = await service(repo, new FakePresigner()).getEmail({
      handle,
    });

    expect(detail.status).toBe('bounced');
    expect(detail.deliveryEvents).toEqual([delivered, bounced]);
  });
});

describe('EmailReadService.getEmailWithDownloadUrls', () => {
  it('returns the detail with a 5-minute download URL on every attachment, without the .eml fields', async () => {
    const repo = new FakeDao();
    const presigner = new FakePresigner();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());

    const result = await service(repo, presigner).getEmailWithDownloadUrls({
      handle,
    });

    expect(result.id).toBe(handle);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: '0',
        filename: 'r.pdf',
        downloadUrl: presigner.url,
        downloadUrlExpiresAt: '2026-07-17T12:05:00.000Z', // now + 300s
      }),
    ]);
    expect(presigner.last?.key).toBe('attachments/inbound/i1/0');
    expect(presigner.last?.contentType).toBe('application/octet-stream');
    expect(presigner.last?.expiresInSeconds).toBe(300);
    expect(result).not.toHaveProperty('rawAvailable');
    expect(result).not.toHaveProperty('rawSuspicious');
  });

  it('matches getEmail apart from the download URLs and the .eml fields', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    const svc = service(repo, new FakePresigner());

    const detail = await svc.getEmail({ handle });
    const withUrls = await svc.getEmailWithDownloadUrls({ handle });

    const expected: Record<string, unknown> = { ...detail };
    delete expected.rawAvailable;
    delete expected.rawSuspicious;
    delete expected.attachments;
    expect(withUrls).toMatchObject(expected);
    expect(
      withUrls.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      })),
    ).toEqual(detail.attachments);
  });

  it('has exactly getEmail’s keys minus the .eml fields — nothing web-only leaks into /api', async () => {
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow());
    const svc = service(repo, new FakePresigner());

    const webKeys = Object.keys(await svc.getEmail({ handle })).filter((key) => key !== 'rawAvailable' && key !== 'rawSuspicious');
    expect(Object.keys(await svc.getEmailWithDownloadUrls({ handle })).sort()).toEqual(webKeys.sort());
  });

  it('unknown handle → not_found', async () => {
    await expect(
      service(new FakeDao(), new FakePresigner()).getEmailWithDownloadUrls({
        handle: 'not-a-handle',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('EmailReadService.getEmailWithDownloadUrls — presign concurrency', () => {
  it('presigns at most 5 attachments at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const presigner = {
      async presign(): Promise<string> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return 'https://s3.example/presigned';
      },
    } as unknown as FakePresigner;
    const attachments = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      filename: `f${i}.bin`,
      contentType: 'application/octet-stream',
      sizeBytes: 1,
      s3Key: `attachments/inbound/i1/${i}`,
    }));
    const repo = new FakeDao();
    const handle = repo.put(INBOUND_PARTITION, inboundRow({ attachments, attachmentCount: 12, body: { kind: 'inline', text: 'hi' } }));

    const result = await service(repo, presigner).getEmailWithDownloadUrls({ handle });

    expect(result.attachments.map((a) => a.id)).toEqual(attachments.map((a) => a.id));
    expect(maxInFlight).toBe(5);
  });
});
