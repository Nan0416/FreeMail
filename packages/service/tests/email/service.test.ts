import { DOWNLOAD_TOKEN_TTL_SECONDS, type SendEmailRequest } from '@freemail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DownloadTokenRecord,
  DownloadTokensRepo,
} from '../../src/data/download-tokens-repo.js';
import type { EmailsRepo, SentEmailRecord, SentStatusUpdate } from '../../src/data/emails-repo.js';
import type { OutboundObjectStore } from '../../src/data/outbound-object-store.js';
import { EmailError } from '../../src/email/errors.js';
import type { RawMimeInput } from '../../src/email/mime.js';
import { EmailService, type EmailServiceDeps } from '../../src/email/service.js';
import type { SendRawParams, SesSender } from '../../src/email/ses-sender.js';

class FakeSes implements SesSender {
  readonly calls: SendRawParams[] = [];
  messageId = 'ses-msg-1';
  fail = false;
  send(params: SendRawParams): Promise<{ messageId: string }> {
    this.calls.push(params);
    if (this.fail) {
      return Promise.reject(new Error('ses boom'));
    }
    return Promise.resolve({ messageId: this.messageId });
  }
}

class FakeEmails implements EmailsRepo {
  /** Rows as written by putSent, mutated in place by updateSentStatus (so [0] is the final state). */
  readonly records: SentEmailRecord[] = [];
  readonly statusUpdates: SentStatusUpdate[] = [];
  failPut = false;
  failUpdate = false;
  putSent(record: SentEmailRecord): Promise<void> {
    if (this.failPut) {
      return Promise.reject(new Error('ddb put down'));
    }
    this.records.push({ ...record });
    return Promise.resolve();
  }
  updateSentStatus(update: SentStatusUpdate): Promise<void> {
    this.statusUpdates.push(update);
    if (this.failUpdate) {
      return Promise.reject(new Error('ddb update down'));
    }
    const row = this.records.find((r) => r.id === update.id);
    if (row) {
      row.status = update.status;
      if (update.sesMessageId !== undefined) {
        row.sesMessageId = update.sesMessageId;
      }
      if (update.error !== undefined) {
        row.error = update.error;
      }
    }
    return Promise.resolve();
  }
}

class FakeObjectStore implements OutboundObjectStore {
  readonly puts: { key: string; bytes: Buffer }[] = [];
  failKeyPrefix?: string;
  put(key: string, body: Buffer): Promise<void> {
    if (this.failKeyPrefix !== undefined && key.startsWith(this.failKeyPrefix)) {
      return Promise.reject(new Error('s3 down'));
    }
    this.puts.push({ key, bytes: body });
    return Promise.resolve();
  }
  /** Only the large-attachment (#14) uploads. */
  get attachmentPuts(): { key: string; bytes: Buffer }[] {
    return this.puts.filter((p) => p.key.startsWith('attachments/outbound/'));
  }
  /** Only the sent raw-MIME archive (#29). */
  get archivePuts(): { key: string; bytes: Buffer }[] {
    return this.puts.filter((p) => p.key.startsWith('sent/'));
  }
}

class FakeDownloadTokens implements DownloadTokensRepo {
  readonly created: DownloadTokenRecord[] = [];
  create(record: DownloadTokenRecord): Promise<void> {
    this.created.push(record);
    return Promise.resolve();
  }
  claim(): Promise<DownloadTokenRecord | null> {
    return Promise.resolve(null);
  }
}

const NOW_ISO = '2026-07-17T12:00:00.000Z';
const DOWNLOAD_BASE_URL = 'https://api.example.test';

/** Canonical base64 for `3 * blocks` zero bytes ('AAAA' → three 0x00 bytes, no padding). */
function base64OfBlocks(blocks: number): string {
  return 'AAAA'.repeat(blocks);
}

function makeService(overrides: Partial<EmailServiceDeps> = {}): {
  service: EmailService;
  ses: FakeSes;
  emails: FakeEmails;
  objectStore: FakeObjectStore;
  tokens: FakeDownloadTokens;
  mimeInputs: RawMimeInput[];
} {
  const ses = overrides.ses instanceof FakeSes ? overrides.ses : new FakeSes();
  const emails = overrides.emails instanceof FakeEmails ? overrides.emails : new FakeEmails();
  const objectStore =
    overrides.objectStore instanceof FakeObjectStore
      ? overrides.objectStore
      : new FakeObjectStore();
  const tokens =
    overrides.tokens instanceof FakeDownloadTokens ? overrides.tokens : new FakeDownloadTokens();
  const mimeInputs: RawMimeInput[] = [];
  let tokenSeq = 0;
  const service = new EmailService({
    ses,
    emails,
    objectStore,
    tokens,
    downloadBaseUrl: DOWNLOAD_BASE_URL,
    emailDomain: 'example.com',
    buildMime: (input) => {
      mimeInputs.push(input);
      return Promise.resolve(Buffer.from('RAW-MIME'));
    },
    now: () => new Date(NOW_ISO),
    generateId: () => 'id-1',
    generateToken: () => `tok-${tokenSeq++}`,
    ...overrides,
  });
  return { service, ses, emails, objectStore, tokens, mimeInputs };
}

function request(overrides: Partial<SendEmailRequest> = {}): SendEmailRequest {
  return {
    from: 'me@example.com',
    to: ['friend@other.com'],
    subject: 'Hi',
    text: 'hello',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmailService.send', () => {
  it('archives the MIME, records the attempt, sends, and marks it sent (write-before-send)', async () => {
    const { service, ses, emails, objectStore } = makeService();

    const result = await service.send(
      request({ to: ['a@x.com'], cc: ['c@x.com'], bcc: ['b@x.com'], html: '<p>hi</p>' }),
    );

    expect(result).toEqual({
      id: 'id-1',
      messageId: 'ses-msg-1',
      sentAt: '2026-07-17T12:00:00.000Z',
    });
    expect(ses.calls).toHaveLength(1);
    expect(ses.calls[0]).toMatchObject({
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: ['c@x.com'],
      bcc: ['b@x.com'],
    });
    // The EXACT composed buffer handed to SES is the one archived — not a rebuild.
    expect(objectStore.archivePuts).toHaveLength(1);
    expect(objectStore.archivePuts[0].key).toBe('sent/id-1');
    expect(objectStore.archivePuts[0].bytes).toBe(ses.calls[0].raw);
    // The row was written 'sending' with rawS3Key + no SES id, then transitioned to 'sent'.
    expect(emails.statusUpdates).toEqual([
      { id: 'id-1', sentAt: NOW_ISO, status: 'sent', sesMessageId: 'ses-msg-1' },
    ]);
    // Final row state after the in-place status update.
    expect(emails.records[0]).toMatchObject({
      id: 'id-1',
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: ['c@x.com'],
      bcc: ['b@x.com'],
      subject: 'Hi',
      status: 'sent',
      rawS3Key: 'sent/id-1',
      sesMessageId: 'ses-msg-1',
      attachmentCount: 0,
      sizeBytes: Buffer.from('RAW-MIME').length,
    });
  });

  it('passes the display name + bcc to the MIME builder AND the SES envelope', async () => {
    const { service, ses, mimeInputs } = makeService();
    await service.send(request({ fromName: 'Me', to: ['a@x.com'], bcc: ['b@x.com'] }));
    // bcc reaches both the builder (which strips it from headers via keepBcc) and the envelope.
    expect(mimeInputs[0]).toMatchObject({
      from: 'me@example.com',
      fromName: 'Me',
      bcc: ['b@x.com'],
    });
    expect(ses.calls[0]?.bcc).toEqual(['b@x.com']);
  });

  it('accepts a sender under a subdomain of the configured domain', async () => {
    const { service, ses } = makeService();
    await service.send(request({ from: 'bot@mail.example.com' }));
    expect(ses.calls[0]?.from).toBe('bot@mail.example.com');
  });

  it('rejects a sender outside the configured domain with invalid_sender (no send, no archive)', async () => {
    const { service, ses, objectStore, emails } = makeService();
    await expect(service.send(request({ from: 'me@evil.com' }))).rejects.toMatchObject({
      code: 'invalid_sender',
      status: 400,
    });
    expect(ses.calls).toHaveLength(0);
    expect(objectStore.puts).toHaveLength(0);
    expect(emails.records).toHaveLength(0);
  });

  it('rejects a malformed sender address with invalid_sender', async () => {
    const { service } = makeService();
    await expect(service.send(request({ from: 'not-an-email' }))).rejects.toBeInstanceOf(
      EmailError,
    );
  });

  it('requires at least one recipient', async () => {
    const { service } = makeService();
    await expect(
      service.send(request({ to: [], cc: undefined, bcc: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an invalid recipient address', async () => {
    const { service } = makeService();
    await expect(service.send(request({ to: ['nope'] }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects more than the recipient cap', async () => {
    const { service } = makeService();
    const to = Array.from({ length: 51 }, (_, i) => `r${i}@x.com`);
    await expect(service.send(request({ to }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('requires a text or html body', async () => {
    const { service } = makeService();
    await expect(service.send(request({ text: undefined, html: undefined }))).rejects.toMatchObject(
      { code: 'invalid_request' },
    );
  });

  it('rejects an attachment with invalid base64', async () => {
    const { service, ses } = makeService();
    await expect(
      service.send(
        request({
          attachments: [
            {
              filename: 'x.bin',
              contentType: 'application/octet-stream',
              contentBase64: 'not base64 !!!',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(ses.calls).toHaveLength(0);
  });

  // Malformed base64 that Buffer.from would silently truncate/ignore, so it must be
  // rejected outright: a lone char, all-padding, wrong length, and a non-alphabet char.
  it.each(['A', '====', 'AAAAA', 'AA*A'])(
    'rejects non-canonical base64 attachment content %j',
    async (contentBase64) => {
      const { service, ses } = makeService();
      await expect(
        service.send(
          request({
            attachments: [
              { filename: 'x.bin', contentType: 'application/octet-stream', contentBase64 },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(ses.calls).toHaveLength(0);
    },
  );

  it('rejects attachments whose total exceeds the size cap (before sending)', async () => {
    const { service, ses } = makeService();
    // ~8 MB decoded — 'AAAA' (4 base64 chars) decodes to 3 bytes.
    const big = 'AAAA'.repeat(3 * 1024 * 1024);
    await expect(
      service.send(
        request({
          attachments: [
            { filename: 'big.bin', contentType: 'application/octet-stream', contentBase64: big },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(ses.calls).toHaveLength(0);
  });

  it('normalizes attachment content (strips whitespace) and counts it', async () => {
    const { service, emails, mimeInputs } = makeService();
    const b64 = Buffer.from('file body').toString('base64');
    await service.send(
      request({
        attachments: [
          { filename: 'note.txt', contentType: 'text/plain', contentBase64: `${b64}\n` },
        ],
      }),
    );
    expect(mimeInputs[0]?.attachments[0]?.contentBase64).toBe(b64);
    expect(emails.records[0]?.attachmentCount).toBe(1);
  });
});

describe('EmailService.send — write-before-send failure paths (#29)', () => {
  it('FAILS CLOSED when the MIME archive write fails: no send, no row', async () => {
    const objectStore = new FakeObjectStore();
    objectStore.failKeyPrefix = 'sent/';
    const { service, ses, emails } = makeService({ objectStore });

    await expect(service.send(request())).rejects.toThrow('s3 down');
    expect(ses.calls).toHaveLength(0);
    expect(emails.records).toHaveLength(0);
    expect(emails.statusUpdates).toHaveLength(0);
  });

  it('FAILS CLOSED when the sending-row write fails: no send', async () => {
    const emails = new FakeEmails();
    emails.failPut = true;
    const { service, ses, objectStore } = makeService({ emails });

    await expect(service.send(request())).rejects.toThrow('ddb put down');
    expect(ses.calls).toHaveLength(0);
    // The archive object was written before the row (orphan, harmless + RETAINed).
    expect(objectStore.archivePuts).toHaveLength(1);
    expect(emails.statusUpdates).toHaveLength(0);
  });

  it('records send_failed and rethrows when SES rejects the message', async () => {
    const ses = new FakeSes();
    ses.fail = true;
    const { service, emails, objectStore } = makeService({ ses });

    await expect(service.send(request())).rejects.toThrow('ses boom');
    // Archived + recorded, then marked send_failed with the reason.
    expect(objectStore.archivePuts).toHaveLength(1);
    expect(emails.statusUpdates).toEqual([
      { id: 'id-1', sentAt: NOW_ISO, status: 'send_failed', error: 'ses boom' },
    ]);
    expect(emails.records[0]).toMatchObject({ status: 'send_failed', error: 'ses boom' });
    expect(emails.records[0]?.sesMessageId).toBeUndefined();
  });

  it('still succeeds when the terminal status update fails, logging correlating ids', async () => {
    const emails = new FakeEmails();
    emails.failUpdate = true;
    const { service, ses } = makeService({ emails });

    const result = await service.send(request());

    // Delivery is the contract: the send succeeds even though the row stays 'sending'.
    expect(result.messageId).toBe('ses-msg-1');
    expect(ses.calls).toHaveLength(1);
    expect(emails.records[0]?.status).toBe('sending');
    expect(console.error).toHaveBeenCalledWith(
      'Failed to update sent-email status',
      { emailId: 'id-1', status: 'sent' },
      expect.any(Error),
    );
  });
});

describe('EmailService.send — large attachments (#14)', () => {
  // 'AAAA' decodes to 3 bytes; MAX_EMBED_ATTACHMENT_BYTES = 3 MB = 3 * 1024 * 1024.
  const EMBED_LIMIT_BLOCKS = 1024 * 1024; // exactly 3 MB decoded
  const LARGE_BLOCKS = 1_200_000; // 3.6 MB decoded — above the embed limit, under the 7 MB total cap

  it('uploads a large attachment to S3, mints a token, and links it in the body instead of embedding', async () => {
    const { service, objectStore, tokens, mimeInputs, emails } = makeService();

    await service.send(
      request({
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            contentBase64: base64OfBlocks(LARGE_BLOCKS),
          },
        ],
      }),
    );

    // Not embedded in the MIME.
    expect(mimeInputs[0]?.attachments).toEqual([]);
    // Uploaded to the opaque outbound key.
    expect(objectStore.attachmentPuts).toHaveLength(1);
    expect(objectStore.attachmentPuts[0].key).toBe('attachments/outbound/id-1/0');
    expect(objectStore.attachmentPuts[0].bytes.length).toBe(LARGE_BLOCKS * 3);
    // Token minted with server-authoritative expiry + TTL and a zero counter.
    expect(tokens.created).toHaveLength(1);
    const expiresAt = new Date(
      Date.parse(NOW_ISO) + DOWNLOAD_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    expect(tokens.created[0]).toEqual({
      token: 'tok-0',
      s3Key: 'attachments/outbound/id-1/0',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: LARGE_BLOCKS * 3,
      emailId: 'id-1',
      createdAt: NOW_ISO,
      expiresAt,
      ttl: Math.floor(Date.parse(expiresAt) / 1000),
      revoked: false,
      downloadCount: 0,
    });
    // Linked in the body, not embedded — and still counted as an attachment on the record.
    expect(mimeInputs[0]?.text).toContain('https://api.example.test/d/tok-0');
    expect(emails.records[0]?.attachmentCount).toBe(1);
  });

  it('embeds an attachment at exactly the embed limit (boundary — no upload, no token)', async () => {
    const { service, objectStore, tokens, mimeInputs } = makeService();
    await service.send(
      request({
        attachments: [
          {
            filename: 'ok.bin',
            contentType: 'application/octet-stream',
            contentBase64: base64OfBlocks(EMBED_LIMIT_BLOCKS),
          },
        ],
      }),
    );
    expect(mimeInputs[0]?.attachments).toHaveLength(1);
    expect(objectStore.attachmentPuts).toHaveLength(0);
    expect(tokens.created).toHaveLength(0);
  });

  it('links an attachment one byte over the embed limit (boundary)', async () => {
    const { service, objectStore, tokens, mimeInputs } = makeService();
    // One 3-byte block over the exact 3 MB limit → routed to a link.
    await service.send(
      request({
        attachments: [
          {
            filename: 'over.bin',
            contentType: 'application/octet-stream',
            contentBase64: base64OfBlocks(EMBED_LIMIT_BLOCKS + 1),
          },
        ],
      }),
    );
    expect(mimeInputs[0]?.attachments).toEqual([]);
    expect(objectStore.attachmentPuts).toHaveLength(1);
    expect(tokens.created).toHaveLength(1);
  });

  it('mixes embedded small + linked large attachments in one message', async () => {
    const { service, objectStore, tokens, mimeInputs } = makeService();
    const small = Buffer.from('a small file').toString('base64');
    await service.send(
      request({
        attachments: [
          { filename: 'small.txt', contentType: 'text/plain', contentBase64: small },
          {
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            contentBase64: base64OfBlocks(LARGE_BLOCKS),
          },
        ],
      }),
    );
    // Only the small one is embedded; the large one is a link.
    expect(mimeInputs[0]?.attachments).toHaveLength(1);
    expect(mimeInputs[0]?.attachments[0]?.filename).toBe('small.txt');
    expect(objectStore.attachmentPuts).toHaveLength(1);
    expect(tokens.created).toHaveLength(1);
    expect(tokens.created[0]?.filename).toBe('big.bin');
  });

  it('links large attachments into an HTML-only body with an escaped anchor', async () => {
    const { service, mimeInputs } = makeService();
    await service.send(
      request({
        text: undefined,
        html: '<p>see attached</p>',
        attachments: [
          {
            filename: 'q1"report.pdf',
            contentType: 'application/pdf',
            contentBase64: base64OfBlocks(LARGE_BLOCKS),
          },
        ],
      }),
    );
    expect(mimeInputs[0]?.text).toBeUndefined();
    expect(mimeInputs[0]?.html).toContain('<p>see attached</p>');
    expect(mimeInputs[0]?.html).toContain('<a href="https://api.example.test/d/tok-0">');
    // The quote in the filename is escaped, not rendered raw.
    expect(mimeInputs[0]?.html).toContain('q1&quot;report.pdf');
  });

  it('mints one token per large attachment with per-file keys and sequential tokens', async () => {
    const { service, objectStore, tokens } = makeService();
    const blocks = 1_050_000; // 3.15 MB each; two = 6.3 MB, under the 7 MB total cap
    await service.send(
      request({
        attachments: [
          {
            filename: 'a.bin',
            contentType: 'application/octet-stream',
            contentBase64: base64OfBlocks(blocks),
          },
          {
            filename: 'b.bin',
            contentType: 'application/octet-stream',
            contentBase64: base64OfBlocks(blocks),
          },
        ],
      }),
    );
    expect(objectStore.attachmentPuts.map((p) => p.key)).toEqual([
      'attachments/outbound/id-1/0',
      'attachments/outbound/id-1/1',
    ]);
    expect(tokens.created.map((t) => t.token)).toEqual(['tok-0', 'tok-1']);
  });
});
