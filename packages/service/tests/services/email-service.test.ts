import { DOWNLOAD_TOKEN_TTL_SECONDS, type SendEmailRequest } from '@freemail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaimDownloadTokenOutput,
  CreateDownloadTokenInput,
  CreateDownloadTokenOutput,
  DownloadTokensDao,
} from '../../src/data/download-tokens-dao.js';
import type {
  EmailsDao,
  GetEmailInput,
  CreateInboundEmailOutput,
  CreateSentEmailInput,
  CreateSentEmailOutput,
  GetEmailOutput,
  ListEmailSummariesOutput,
  QueryEmailsByDirectionOutput,
  UpdateSentEmailStatusInput,
  UpdateSentEmailStatusOutput,
} from '../../src/data/emails-dao.js';
import type { MailBodyContent, MailBodyStore } from '../../src/facades/s3-mail-body-store.js';
import type { OutboundObjectStore } from '../../src/facades/s3-outbound-object-store.js';
import type { UploadStore, UploadedObject } from '../../src/facades/s3-upload-store.js';
import { MAX_INLINE_BODY_BYTES } from '../../src/services/email-body-storage.js';
import { EmailError } from '../../src/utils/errors.js';
import { decodeEmailRef, encodeEmailRef } from '../../src/utils/email-ref.js';
import type { RawMimeInput } from '../../src/utils/mime.js';
import { EmailService, type EmailServiceDeps } from '../../src/services/email-service.js';
import type { SendRawParams, SesSender } from '../../src/facades/ses-email-facade.js';

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

class FakeEmails implements EmailsDao {
  /** Rows as written by putSent, mutated in place by updateSentStatus (so [0] is the final state). */
  readonly records: CreateSentEmailInput[] = [];
  readonly statusUpdates: UpdateSentEmailStatusInput[] = [];
  failPut = false;
  failUpdate = false;
  createSentEmail(record: CreateSentEmailInput): Promise<CreateSentEmailOutput> {
    if (this.failPut) {
      return Promise.reject(new Error('ddb put down'));
    }
    this.records.push({ ...record });
    return Promise.resolve({});
  }
  updateSentEmailStatus(update: UpdateSentEmailStatusInput): Promise<UpdateSentEmailStatusOutput> {
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
    return Promise.resolve({});
  }
  createInboundEmail(): Promise<CreateInboundEmailOutput> {
    return Promise.resolve({ created: true });
  }
  queryEmailsByDirection(): Promise<QueryEmailsByDirectionOutput> {
    return Promise.resolve({ emails: [] });
  }
  listEmailSummaries(): Promise<ListEmailSummariesOutput> {
    return Promise.resolve({ emails: [] });
  }
  /** Stored rows getEmail can find, by `pk|sk`. */
  readonly stored = new Map<string, GetEmailOutput>();
  readonly gets: GetEmailInput[] = [];
  getEmail(input: GetEmailInput): Promise<GetEmailOutput | null> {
    this.gets.push(input);
    return Promise.resolve(this.stored.get(`${input.pk}|${input.sk}`) ?? null);
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
  /** Only the sent raw-MIME archive (#29). */
  get archivePuts(): { key: string; bytes: Buffer }[] {
    return this.puts.filter((p) => p.key.startsWith('sent/'));
  }
}

class FakeDownloadTokens implements DownloadTokensDao {
  readonly created: CreateDownloadTokenInput[] = [];
  createDownloadToken(record: CreateDownloadTokenInput): Promise<CreateDownloadTokenOutput> {
    this.created.push(record);
    return Promise.resolve({});
  }
  claimDownloadToken(): Promise<ClaimDownloadTokenOutput | null> {
    return Promise.resolve(null);
  }
}

const NOW_ISO = '2026-07-17T12:00:00.000Z';
const DOWNLOAD_BASE_URL = 'https://api.example.test';

/** A finished upload in S3: what HEAD reports, plus (optionally) real bytes for embedding. */
interface StoredUpload {
  readonly meta: UploadedObject;
  readonly bytes?: Buffer;
}

class FakeUploadStore implements UploadStore {
  readonly objects = new Map<string, StoredUpload>();
  readonly copies: { source: string; dest: string }[] = [];
  readonly reads: string[] = [];
  failCopy = false;
  /** Seed a finished upload; returns its upload id. */
  add(n: number, filename: string, contentType: string, content: Buffer | number): string {
    const id = uploadId(n);
    const bytes = typeof content === 'number' ? undefined : content;
    const sizeBytes = typeof content === 'number' ? content : content.length;
    this.objects.set(`uploads/${id}`, { meta: { filename, contentType, sizeBytes }, bytes });
    return id;
  }
  presignPut(): Promise<string> {
    return Promise.resolve('https://bucket.s3.example/uploads/x');
  }
  head(key: string): Promise<UploadedObject | null> {
    return Promise.resolve(this.objects.get(key)?.meta ?? null);
  }
  copy(source: string, dest: string): Promise<boolean> {
    if (this.failCopy) {
      return Promise.reject(new Error('s3 copy down'));
    }
    const object = this.objects.get(source);
    if (!object) {
      return Promise.resolve(false);
    }
    this.copies.push({ source, dest });
    this.objects.set(dest, object);
    return Promise.resolve(true);
  }
  getBytes(key: string): Promise<Buffer> {
    this.reads.push(key);
    const object = this.objects.get(key);
    return Promise.resolve(object?.bytes ?? Buffer.alloc(object?.meta.sizeBytes ?? 0));
  }
}

/** A well-formed (22-char base64url) upload id, distinct per n. */
function uploadId(n: number): string {
  return `U${String(n).padStart(21, '0')}`;
}

const MB = 1024 * 1024;

class FakeBodyStore implements MailBodyStore {
  readonly puts = new Map<string, MailBodyContent>();
  fail = false;
  putBody(key: string, body: MailBodyContent): Promise<void> {
    if (this.fail) {
      return Promise.reject(new Error('s3 body put down'));
    }
    this.puts.set(key, body);
    return Promise.resolve();
  }
  getBody(key: string): Promise<MailBodyContent | null> {
    return Promise.resolve(this.puts.get(key) ?? null);
  }
}

function makeService(overrides: Partial<EmailServiceDeps> = {}): {
  service: EmailService;
  ses: FakeSes;
  emails: FakeEmails;
  objectStore: FakeObjectStore;
  bodies: FakeBodyStore;
  uploads: FakeUploadStore;
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
  const bodies = overrides.bodies instanceof FakeBodyStore ? overrides.bodies : new FakeBodyStore();
  const uploads =
    overrides.uploads instanceof FakeUploadStore ? overrides.uploads : new FakeUploadStore();
  const mimeInputs: RawMimeInput[] = [];
  let tokenSeq = 0;
  const service = new EmailService({
    ses,
    emailsDao: emails,
    objectStore,
    bodies,
    uploads,
    tokensDao: tokens,
    downloadBaseUrl: DOWNLOAD_BASE_URL,
    emailDomain: 'example.com',
    sesRegion: 'us-east-1',
    canReadMailbox: true,
    buildMime: (input) => {
      mimeInputs.push(input);
      return Promise.resolve(Buffer.from('RAW-MIME'));
    },
    now: () => new Date(NOW_ISO),
    generateId: () => 'id-1',
    generateToken: () => `tok-${tokenSeq++}`,
    ...overrides,
  });
  return { service, ses, emails, objectStore, bodies, uploads, tokens, mimeInputs };
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

describe('EmailService.sendEmail', () => {
  it('archives the MIME, records the attempt, sends, and marks it sent (write-before-send)', async () => {
    const setup = makeService();

    const result = await setup.service.sendEmail(
      request({ to: ['a@x.com'], cc: ['c@x.com'], bcc: ['b@x.com'], html: '<p>hi</p>' }),
    );

    expect(result).toEqual({
      id: encodeEmailRef({ pk: 'SENT', sk: '2026-07-17T12:00:00.000Z#id-1' }),
      messageId: 'ses-msg-1',
      sentAt: '2026-07-17T12:00:00.000Z',
    });
    // The returned id is the read API's handle, so the caller can open what it just sent.
    expect(decodeEmailRef(result.id)).toEqual({
      pk: 'SENT',
      sk: '2026-07-17T12:00:00.000Z#id-1',
    });
    expect(setup.ses.calls).toHaveLength(1);
    expect(setup.ses.calls[0]).toMatchObject({
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: ['c@x.com'],
      bcc: ['b@x.com'],
    });
    // The EXACT composed buffer handed to SES is the one archived — not a rebuild.
    expect(setup.objectStore.archivePuts).toHaveLength(1);
    expect(setup.objectStore.archivePuts[0].key).toBe('sent/id-1');
    expect(setup.objectStore.archivePuts[0].bytes).toBe(setup.ses.calls[0].raw);
    // The row was written 'sending' with rawS3Key + no SES id, then transitioned to 'sent'.
    expect(setup.emails.statusUpdates).toEqual([
      {
        id: 'id-1',
        sentAt: NOW_ISO,
        status: 'sent',
        sesMessageId: 'ses-msg-1',
        messageIdHeader: '<ses-msg-1@email.amazonses.com>',
      },
    ]);
    // Final row state after the in-place status update.
    expect(setup.emails.records[0]).toMatchObject({
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
      attachments: [],
    });
    expect(setup.uploads.copies).toHaveLength(0);
  });

  it('passes the display name + bcc to the MIME builder AND the SES envelope', async () => {
    const setup = makeService();
    await setup.service.sendEmail(request({ fromName: 'Me', to: ['a@x.com'], bcc: ['b@x.com'] }));
    // bcc reaches both the builder (which strips it from headers via keepBcc) and the envelope.
    expect(setup.mimeInputs[0]).toMatchObject({
      from: 'me@example.com',
      fromName: 'Me',
      bcc: ['b@x.com'],
    });
    expect(setup.ses.calls[0]?.bcc).toEqual(['b@x.com']);
  });

  it('accepts a sender under a subdomain of the configured domain', async () => {
    const setup = makeService();
    await setup.service.sendEmail(request({ from: 'bot@mail.example.com' }));
    expect(setup.ses.calls[0]?.from).toBe('bot@mail.example.com');
  });

  it('rejects a sender outside the configured domain with invalid_sender (no send, no archive)', async () => {
    const setup = makeService();
    await expect(setup.service.sendEmail(request({ from: 'me@evil.com' }))).rejects.toMatchObject({
      code: 'invalid_sender',
      status: 400,
    });
    expect(setup.ses.calls).toHaveLength(0);
    expect(setup.objectStore.puts).toHaveLength(0);
    expect(setup.emails.records).toHaveLength(0);
  });

  it('rejects a malformed sender address with invalid_sender', async () => {
    const setup = makeService();
    await expect(setup.service.sendEmail(request({ from: 'not-an-email' }))).rejects.toBeInstanceOf(
      EmailError,
    );
  });

  it('requires at least one recipient', async () => {
    const setup = makeService();
    await expect(
      setup.service.sendEmail(request({ to: [], cc: undefined, bcc: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an invalid recipient address', async () => {
    const setup = makeService();
    await expect(setup.service.sendEmail(request({ to: ['nope'] }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects more than the recipient cap', async () => {
    const setup = makeService();
    const to = Array.from({ length: 51 }, (_, i) => `r${i}@x.com`);
    await expect(setup.service.sendEmail(request({ to }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('requires a text or html body', async () => {
    const setup = makeService();
    await expect(
      setup.service.sendEmail(request({ text: undefined, html: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an attachment that is not an upload reference (no S3 call, no send)', async () => {
    const setup = makeService();
    await expect(
      setup.service.sendEmail(request({ attachments: [{ uploadId: '../uploads/other' }] })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(setup.ses.calls).toHaveLength(0);
  });

  it('rejects an upload that was never uploaded or has expired (no archive, no send)', async () => {
    const setup = makeService();
    await expect(
      setup.service.sendEmail(request({ attachments: [{ uploadId: uploadId(9) }] })),
    ).rejects.toThrow(/was not found/);
    expect(setup.objectStore.archivePuts).toHaveLength(0);
    expect(setup.ses.calls).toHaveLength(0);
  });

  it('rejects more attachments than the cap', async () => {
    const setup = makeService();
    const attachments = Array.from({ length: 21 }, (_, i) => ({
      uploadId: setup.uploads.add(i, `f${i}`, 'text/plain', 1),
    }));
    await expect(setup.service.sendEmail(request({ attachments }))).rejects.toThrow(/at most 20/);
  });

  it('copies each upload once to attachments/sent/<id>/<index>, embedding small ones from the upload', async () => {
    const setup = makeService();
    const a = setup.uploads.add(1, 'a.txt', 'text/plain', Buffer.from('aaa'));
    const b = setup.uploads.add(2, 'b.pdf', 'application/pdf', Buffer.from('bbbb'));

    await setup.service.sendEmail(request({ attachments: [{ uploadId: a }, { uploadId: b }] }));

    expect(setup.uploads.copies).toEqual([
      { source: `uploads/${a}`, dest: 'attachments/sent/id-1/0' },
      { source: `uploads/${b}`, dest: 'attachments/sent/id-1/1' },
    ]);
    // Embedded from the upload itself (an MCP role without the read tools can't read the sent
    // copies), with the filename + type S3 recorded at upload.
    expect(setup.uploads.reads).toEqual([`uploads/${a}`, `uploads/${b}`]);
    expect(setup.mimeInputs[0]?.attachments).toEqual([
      {
        filename: 'a.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('aaa').toString('base64'),
      },
      {
        filename: 'b.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.from('bbbb').toString('base64'),
      },
    ]);
    expect(setup.emails.records[0]?.attachments).toEqual([
      {
        id: '0',
        filename: 'a.txt',
        contentType: 'text/plain',
        sizeBytes: 3,
        s3Key: 'attachments/sent/id-1/0',
      },
      {
        id: '1',
        filename: 'b.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4,
        s3Key: 'attachments/sent/id-1/1',
      },
    ]);
    expect(setup.emails.records[0]?.attachmentCount).toBe(2);
    expect(setup.tokens.created).toHaveLength(0);
  });
});

describe('EmailService.sendEmail — stored body', () => {
  it('stores a small body inline on the sent row', async () => {
    const setup = makeService();

    await setup.service.sendEmail(request({ text: 'Hello inline', html: '<p>Hello inline</p>' }));

    expect(setup.emails.records[0]?.body).toEqual({
      kind: 'inline',
      text: 'Hello inline',
      html: '<p>Hello inline</p>',
    });
    expect(setup.bodies.puts.size).toBe(0);
  });

  it('stores a large body in S3 before writing the row, and points the row at it', async () => {
    const setup = makeService();
    const createSent = setup.emails.createSentEmail.bind(setup.emails);
    let bodyStoredBeforeRow = false;
    setup.emails.createSentEmail = (record) => {
      bodyStoredBeforeRow = setup.bodies.puts.has('bodies/sent/id-1.json');
      return createSent(record);
    };
    const big = 'y'.repeat(MAX_INLINE_BODY_BYTES + 1);

    await setup.service.sendEmail(request({ text: big }));

    expect(bodyStoredBeforeRow).toBe(true);
    expect(setup.emails.records[0]?.body).toEqual({
      kind: 's3',
      s3Key: 'bodies/sent/id-1.json',
    });
    expect(setup.bodies.puts.get('bodies/sent/id-1.json')?.text).toBe(big);
  });

  it('stores the body exactly as sent — download links included', async () => {
    const setup = makeService();

    // 5 MB: over the embed limit, so it becomes a download link.
    const big = setup.uploads.add(1, 'big.bin', 'application/octet-stream', 5 * MB);
    await setup.service.sendEmail(
      request({ text: 'See attached.', attachments: [{ uploadId: big }] }),
    );

    const body = setup.emails.records[0]?.body;
    expect(body?.kind).toBe('inline');
    expect(body?.kind === 'inline' ? body.text : '').toContain('https://api.example.test/d/tok-0');
  });
});

describe('EmailService.sendEmail — write-before-send failure paths (#29)', () => {
  it('FAILS CLOSED when the MIME archive write fails: no send, no row', async () => {
    const objectStore = new FakeObjectStore();
    objectStore.failKeyPrefix = 'sent/';
    const setup = makeService({ objectStore });

    await expect(setup.service.sendEmail(request())).rejects.toThrow('s3 down');
    expect(setup.ses.calls).toHaveLength(0);
    expect(setup.emails.records).toHaveLength(0);
    expect(setup.emails.statusUpdates).toHaveLength(0);
  });

  it('answers "upload not found" (400) when an upload vanishes between its HEAD and its copy', async () => {
    const setup = makeService();
    const a = setup.uploads.add(1, 'a.txt', 'text/plain', Buffer.from('aaa'));
    const head = setup.uploads.head.bind(setup.uploads);
    setup.uploads.head = async (key) => {
      const meta = await head(key);
      setup.uploads.objects.delete(key); // swept right after the HEAD
      return meta;
    };

    await expect(
      setup.service.sendEmail(request({ attachments: [{ uploadId: a }] })),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('was not found'),
    });
    expect(setup.emails.records).toEqual([]);
    expect(setup.ses.calls).toHaveLength(0);
  });

  it('FAILS CLOSED when copying an upload fails: no send, no row', async () => {
    const setup = makeService();
    const a = setup.uploads.add(1, 'a.txt', 'text/plain', Buffer.from('aaa'));
    setup.uploads.failCopy = true;

    await expect(
      setup.service.sendEmail(request({ attachments: [{ uploadId: a }] })),
    ).rejects.toThrow(/s3 copy down/);
    expect(setup.emails.records).toEqual([]);
    expect(setup.ses.calls).toHaveLength(0);
  });

  it('FAILS CLOSED when a large-body write fails: no row, no send', async () => {
    const setup = makeService();
    setup.bodies.fail = true;

    await expect(
      setup.service.sendEmail(request({ text: 'z'.repeat(MAX_INLINE_BODY_BYTES + 1) })),
    ).rejects.toThrow(/s3 body put down/);

    expect(setup.emails.records).toEqual([]);
    expect(setup.ses.calls).toEqual([]);
  });

  it('FAILS CLOSED when the sending-row write fails: no send', async () => {
    const emails = new FakeEmails();
    emails.failPut = true;
    const setup = makeService({ emails });

    await expect(setup.service.sendEmail(request())).rejects.toThrow('ddb put down');
    expect(setup.ses.calls).toHaveLength(0);
    // The archive object was written before the row (orphan, harmless + RETAINed).
    expect(setup.objectStore.archivePuts).toHaveLength(1);
    expect(emails.statusUpdates).toHaveLength(0);
  });

  it('records send_failed and rethrows when SES rejects the message', async () => {
    const ses = new FakeSes();
    ses.fail = true;
    const setup = makeService({ ses });

    await expect(setup.service.sendEmail(request())).rejects.toThrow('ses boom');
    // Archived + recorded, then marked send_failed with the reason.
    expect(setup.objectStore.archivePuts).toHaveLength(1);
    expect(setup.emails.statusUpdates).toEqual([
      { id: 'id-1', sentAt: NOW_ISO, status: 'send_failed', error: 'ses boom' },
    ]);
    expect(setup.emails.records[0]).toMatchObject({ status: 'send_failed', error: 'ses boom' });
    expect(setup.emails.records[0]?.sesMessageId).toBeUndefined();
  });

  it('still succeeds when the terminal status update fails, logging correlating ids', async () => {
    const emails = new FakeEmails();
    emails.failUpdate = true;
    const setup = makeService({ emails });

    const result = await setup.service.sendEmail(request());

    // Delivery is the contract: the send succeeds even though the row stays 'sending'.
    expect(result.messageId).toBe('ses-msg-1');
    expect(setup.ses.calls).toHaveLength(1);
    expect(emails.records[0]?.status).toBe('sending');
    expect(console.error).toHaveBeenCalledWith(
      'Failed to update sent-email status',
      { emailId: 'id-1', status: 'sent' },
      expect.any(Error),
    );
  });
});

describe('EmailService.sendEmail — embed or link (#14)', () => {
  it('embeds a file at exactly the per-file limit; links one byte over', async () => {
    const setup = makeService();
    const exact = setup.uploads.add(1, 'exact.bin', 'application/octet-stream', 3 * MB);
    const over = setup.uploads.add(2, 'over.bin', 'application/octet-stream', 3 * MB + 1);

    await setup.service.sendEmail(
      request({ attachments: [{ uploadId: exact }, { uploadId: over }] }),
    );

    expect(setup.mimeInputs[0]?.attachments.map((a) => a.filename)).toEqual(['exact.bin']);
    expect(setup.tokens.created.map((t) => t.filename)).toEqual(['over.bin']);
  });

  it('links a file that would pass the message’s embed budget', async () => {
    const setup = makeService();
    // Four 3 MB files: three fit the 10 MB budget (9 MB), the fourth is linked.
    const ids = [1, 2, 3, 4].map((n) =>
      setup.uploads.add(n, `f${n}.bin`, 'application/octet-stream', 3 * MB),
    );

    await setup.service.sendEmail(request({ attachments: ids.map((uploadId) => ({ uploadId })) }));

    expect(setup.mimeInputs[0]?.attachments.map((a) => a.filename)).toEqual([
      'f1.bin',
      'f2.bin',
      'f3.bin',
    ]);
    expect(setup.tokens.created.map((t) => t.filename)).toEqual(['f4.bin']);
  });

  it('still embeds a small file after a linked one (first fit, in request order)', async () => {
    const setup = makeService();
    const ids = [3, 3, 3, 3, 1].map((size, n) =>
      setup.uploads.add(n, `f${n}.bin`, 'application/octet-stream', size * MB),
    );

    await setup.service.sendEmail(request({ attachments: ids.map((uploadId) => ({ uploadId })) }));

    expect(setup.mimeInputs[0]?.attachments.map((a) => a.filename)).toEqual([
      'f0.bin',
      'f1.bin',
      'f2.bin',
      'f4.bin',
    ]);
    expect(setup.tokens.created.map((t) => t.filename)).toEqual(['f3.bin']);
  });

  it('links a large file: a token for its permanent copy, a link in the body, no embed', async () => {
    const setup = makeService();
    const big = setup.uploads.add(1, 'report.pdf', 'application/pdf', 50 * MB);

    await setup.service.sendEmail(request({ attachments: [{ uploadId: big }] }));

    expect(setup.mimeInputs[0]?.attachments).toEqual([]);
    expect(setup.uploads.reads).toEqual([]); // never pulled into the Lambda
    const expiresAt = new Date(
      Date.parse(NOW_ISO) + DOWNLOAD_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    expect(setup.tokens.created).toEqual([
      {
        token: 'tok-0',
        s3Key: 'attachments/sent/id-1/0',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 50 * MB,
        emailId: 'id-1',
        createdAt: NOW_ISO,
        expiresAt,
        ttl: Math.floor(Date.parse(expiresAt) / 1000),
        revoked: false,
        downloadCount: 0,
        sender: 'me@example.com',
      },
    ]);
    expect(setup.mimeInputs[0]?.text).toContain('https://api.example.test/d/tok-0');
    // The sender's own copy (Sent folder) points at the same permanent key, without a token.
    expect(setup.emails.records[0]?.attachments?.[0]?.s3Key).toBe('attachments/sent/id-1/0');
  });

  it('records which recipients are your own addresses on the token (to/cc/bcc, lowercased)', async () => {
    const setup = makeService();
    const big = setup.uploads.add(1, 'big.bin', 'application/octet-stream', 5 * MB);

    await setup.service.sendEmail(
      request({
        from: 'Me@Example.com',
        to: ['friend@other.com', 'Team@example.com'],
        // A subdomain address never comes back in (inbound covers exactly the domain).
        cc: ['ops@mail.example.com', 'ops@example.com'],
        bcc: ['team@example.com', 'boss@elsewhere.org'],
        attachments: [{ uploadId: big }],
      }),
    );

    expect(setup.tokens.created[0]).toMatchObject({
      sender: 'me@example.com',
      ownDomainRecipients: ['team@example.com', 'ops@example.com'],
    });
  });

  it('counts a bcc-only own address as an own-domain recipient', async () => {
    const setup = makeService();
    const big = setup.uploads.add(1, 'big.bin', 'application/octet-stream', 5 * MB);

    await setup.service.sendEmail(
      request({
        to: ['friend@other.com'],
        bcc: ['me2@example.com'],
        attachments: [{ uploadId: big }],
      }),
    );

    expect(setup.tokens.created[0]?.ownDomainRecipients).toEqual(['me2@example.com']);
  });

  it('records no own-domain recipients when every recipient is elsewhere', async () => {
    const setup = makeService();
    const big = setup.uploads.add(1, 'big.bin', 'application/octet-stream', 5 * MB);

    await setup.service.sendEmail(request({ attachments: [{ uploadId: big }] }));

    expect(setup.tokens.created[0]).not.toHaveProperty('ownDomainRecipients');
  });

  it('links into an HTML-only body with an escaped anchor', async () => {
    const setup = makeService();
    const big = setup.uploads.add(1, 'a&b.pdf', 'application/pdf', 5 * MB);

    await setup.service.sendEmail(
      request({ text: undefined, html: '<p>hi</p>', attachments: [{ uploadId: big }] }),
    );

    expect(setup.mimeInputs[0]?.html).toContain('<a href="https://api.example.test/d/tok-0">');
    expect(setup.mimeInputs[0]?.html).toContain('a&amp;b.pdf');
  });

  it('honors deploy-configured limits', async () => {
    const setup = makeService({ embedMaxBytes: 100, embedTotalBytes: 150 });
    const a = setup.uploads.add(1, 'a.txt', 'text/plain', 100);
    const b = setup.uploads.add(2, 'b.txt', 'text/plain', 100); // would pass the 150 total
    const c = setup.uploads.add(3, 'c.txt', 'text/plain', 101); // over the per-file limit

    await setup.service.sendEmail(
      request({ attachments: [{ uploadId: a }, { uploadId: b }, { uploadId: c }] }),
    );

    expect(setup.mimeInputs[0]?.attachments.map((x) => x.filename)).toEqual(['a.txt']);
    expect(setup.tokens.created.map((t) => t.filename)).toEqual(['b.txt', 'c.txt']);
  });
});

describe('EmailService.sendEmail — replies (inReplyTo / replyTo)', () => {
  const INBOUND_SK = '2026-07-16T09:00:00.000Z#ses-in-1';
  const SENT_SK = '2026-07-16T08:00:00.000Z#sent-0';

  function inboundParent(over: Partial<GetEmailOutput> = {}): GetEmailOutput {
    return {
      direction: 'inbound',
      pk: 'INBOUND',
      sk: INBOUND_SK,
      id: 'ses-in-1',
      sesMessageId: 'ses-in-1',
      from: 'friend@other.com',
      to: ['me@example.com'],
      cc: [],
      subject: 'Lunch?',
      receivedAt: '2026-07-16T09:00:00.000Z',
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
      parseStatus: 'ok',
      quarantined: false,
      rawS3Key: 'inbound/ses-in-1',
      sizeBytes: 10,
      messageIdHeader: '<parent@mail.other.com>',
      references: ['<root@mail.other.com>'],
      ...over,
    } as GetEmailOutput;
  }

  function withParent(row: GetEmailOutput, over: Partial<EmailServiceDeps> = {}) {
    const emails = new FakeEmails();
    emails.stored.set(`${row.pk}|${row.sk}`, row);
    return { ...makeService({ emailsDao: emails, ...over }), emails };
  }

  it('threads a reply to a received message and defaults the subject', async () => {
    const setup = withParent(inboundParent());

    const result = await setup.service.sendEmail(
      request({
        subject: undefined,
        inReplyTo: encodeEmailRef({ pk: 'INBOUND', sk: INBOUND_SK }),
      }),
    );

    expect(result.threaded).toBe(true);
    expect(setup.emails.gets).toEqual([{ pk: 'INBOUND', sk: INBOUND_SK }]);
    expect(setup.mimeInputs[0]).toMatchObject({
      subject: 'Re: Lunch?',
      inReplyTo: '<parent@mail.other.com>',
      references: ['<root@mail.other.com>', '<parent@mail.other.com>'],
    });
    // The chain is kept on the sent row, so a reply to this reply stays in the thread.
    expect(setup.emails.records[0]).toMatchObject({
      subject: 'Re: Lunch?',
      references: ['<root@mail.other.com>', '<parent@mail.other.com>'],
    });
  });

  it('keeps an explicit subject', async () => {
    const setup = withParent(inboundParent());

    await setup.service.sendEmail(
      request({
        subject: 'New topic',
        inReplyTo: encodeEmailRef({ pk: 'INBOUND', sk: INBOUND_SK }),
      }),
    );

    expect(setup.mimeInputs[0].subject).toBe('New topic');
  });

  it("threads a follow-up to our own sent message on SES's Message-ID", async () => {
    const sent: GetEmailOutput = {
      direction: 'sent',
      pk: 'SENT',
      sk: SENT_SK,
      id: 'sent-0',
      from: 'me@example.com',
      to: ['friend@other.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Lunch?',
      sentAt: '2026-07-16T08:00:00.000Z',
      sesMessageId: '0100abc-000000',
      attachmentCount: 0,
      sizeBytes: 10,
      status: 'sent',
      references: ['<root@mail.other.com>', '<parent@mail.other.com>'],
    };
    const setup = withParent(sent, { sesRegion: 'us-east-1' });

    await setup.service.sendEmail(
      request({ subject: undefined, inReplyTo: encodeEmailRef({ pk: 'SENT', sk: SENT_SK }) }),
    );

    expect(setup.mimeInputs[0]).toMatchObject({
      subject: 'Re: Lunch?',
      inReplyTo: '<0100abc-000000@email.amazonses.com>',
      references: [
        '<root@mail.other.com>',
        '<parent@mail.other.com>',
        '<0100abc-000000@email.amazonses.com>',
      ],
    });
  });

  it('sends a reply to a received message without a usable Message-ID, unthreaded', async () => {
    const setup = withParent(inboundParent({ messageIdHeader: undefined }));

    const result = await setup.service.sendEmail(
      request({
        subject: undefined,
        inReplyTo: encodeEmailRef({ pk: 'INBOUND', sk: INBOUND_SK }),
      }),
    );

    expect(result.threaded).toBe(false);
    expect(setup.ses.calls).toHaveLength(1);
    expect(setup.mimeInputs[0].subject).toBe('Re: Lunch?');
    expect(setup.mimeInputs[0].inReplyTo).toBeUndefined();
    expect(setup.mimeInputs[0].references).toBeUndefined();
    expect(setup.emails.records[0].references).toBeUndefined();
  });

  it('sends a reply to a sent message SES never accepted, unthreaded', async () => {
    const sent = {
      direction: 'sent',
      pk: 'SENT',
      sk: SENT_SK,
      id: 'sent-0',
      from: 'me@example.com',
      to: [],
      cc: [],
      bcc: [],
      subject: 'x',
      sentAt: '2026-07-16T08:00:00.000Z',
      attachmentCount: 0,
      sizeBytes: 1,
      status: 'send_failed',
    } as GetEmailOutput;
    const setup = withParent(sent);

    const result = await setup.service.sendEmail(
      request({ inReplyTo: encodeEmailRef({ pk: 'SENT', sk: SENT_SK }) }),
    );

    expect(result.threaded).toBe(false);
    expect(setup.mimeInputs[0].inReplyTo).toBeUndefined();
  });

  it.each([
    ['garbage', 'not-a-handle'],
    ['an unknown message', encodeEmailRef({ pk: 'INBOUND', sk: '2020-01-01T00:00:00.000Z#nope' })],
    ['an empty string', ''],
  ])('refuses %s as inReplyTo with invalid_request', async (_label, handle) => {
    const setup = makeService();

    await expect(setup.service.sendEmail(request({ inReplyTo: handle }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(setup.ses.calls).toHaveLength(0);
  });

  it('refuses inReplyTo where the mailbox cannot be read, without touching the table', async () => {
    const setup = withParent(inboundParent(), { canReadMailbox: false });

    await expect(
      setup.service.sendEmail(
        request({ inReplyTo: encodeEmailRef({ pk: 'INBOUND', sk: INBOUND_SK }) }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('receiving'),
    });
    expect(setup.emails.gets).toEqual([]);
  });

  it('sets Reply-To and records it', async () => {
    const setup = makeService();

    await setup.service.sendEmail(request({ replyTo: [' desk@example.com '] }));

    expect(setup.mimeInputs[0].replyTo).toEqual(['desk@example.com']);
    expect(setup.emails.records[0].replyTo).toEqual(['desk@example.com']);
  });

  it.each([
    ['an invalid address', ['not-an-address']],
    ['too many addresses', Array.from({ length: 11 }, (_v, i) => `r${i}@example.com`)],
  ])('rejects %s in replyTo', async (_label, replyTo) => {
    const setup = makeService();

    await expect(setup.service.sendEmail(request({ replyTo }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('records the Message-ID SES gave the message when it is accepted', async () => {
    const setup = makeService();

    await setup.service.sendEmail(request());

    expect(setup.emails.statusUpdates.at(-1)).toMatchObject({
      status: 'sent',
      sesMessageId: 'ses-msg-1',
      messageIdHeader: '<ses-msg-1@email.amazonses.com>',
    });
  });

  it("prefers a sent message's recorded Message-ID over deriving it", async () => {
    const sent = {
      direction: 'sent',
      pk: 'SENT',
      sk: SENT_SK,
      id: 'sent-0',
      from: 'me@example.com',
      to: ['friend@other.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      sentAt: '2026-07-16T08:00:00.000Z',
      sesMessageId: '0100abc-000000',
      messageIdHeader: '<0100abc-000000@eu-west-1.amazonses.com>',
      attachmentCount: 0,
      sizeBytes: 10,
      status: 'sent',
    } as GetEmailOutput;
    const setup = withParent(sent, { sesRegion: 'us-east-1' });

    await setup.service.sendEmail(
      request({ inReplyTo: encodeEmailRef({ pk: 'SENT', sk: SENT_SK }) }),
    );

    expect(setup.mimeInputs[0].inReplyTo).toBe('<0100abc-000000@eu-west-1.amazonses.com>');
  });

  it('threads a reply to an Errors-folder message on its recorded Message-ID', async () => {
    const failed = inboundParent({ pk: 'FAILED', failed: true } as Partial<GetEmailOutput>);
    const setup = withParent(failed);

    const result = await setup.service.sendEmail(
      request({ inReplyTo: encodeEmailRef({ pk: 'FAILED', sk: INBOUND_SK }) }),
    );

    expect(result.threaded).toBe(true);
    expect(setup.mimeInputs[0].inReplyTo).toBe('<parent@mail.other.com>');
  });

  it('records neither when not replying', async () => {
    const setup = makeService();

    await setup.service.sendEmail(request());

    expect(setup.mimeInputs[0].inReplyTo).toBeUndefined();
    expect(setup.mimeInputs[0].replyTo).toBeUndefined();
    expect(setup.emails.records[0].references).toBeUndefined();
    expect(setup.emails.records[0].replyTo).toBeUndefined();
  });

  it('reports threaded only when inReplyTo was given', async () => {
    const setup = makeService();

    expect((await setup.service.sendEmail(request())).threaded).toBeUndefined();
  });
});
