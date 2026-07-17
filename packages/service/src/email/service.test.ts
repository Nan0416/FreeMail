import type { SendEmailRequest } from '@freemail/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailsRepo, SentEmailRecord } from '../data/emails-repo.js';
import { EmailError } from './errors.js';
import type { RawMimeInput } from './mime.js';
import { EmailService, type EmailServiceDeps } from './service.js';
import type { SendRawParams, SesSender } from './ses-sender.js';

class FakeSes implements SesSender {
  readonly calls: SendRawParams[] = [];
  messageId = 'ses-msg-1';
  send(params: SendRawParams): Promise<{ messageId: string }> {
    this.calls.push(params);
    return Promise.resolve({ messageId: this.messageId });
  }
}

class FakeEmails implements EmailsRepo {
  readonly records: SentEmailRecord[] = [];
  fail = false;
  putSent(record: SentEmailRecord): Promise<void> {
    if (this.fail) {
      return Promise.reject(new Error('ddb down'));
    }
    this.records.push(record);
    return Promise.resolve();
  }
}

function makeService(overrides: Partial<EmailServiceDeps> = {}): {
  service: EmailService;
  ses: FakeSes;
  emails: FakeEmails;
  mimeInputs: RawMimeInput[];
} {
  const ses = overrides.ses instanceof FakeSes ? overrides.ses : new FakeSes();
  const emails = overrides.emails instanceof FakeEmails ? overrides.emails : new FakeEmails();
  const mimeInputs: RawMimeInput[] = [];
  const service = new EmailService({
    ses,
    emails,
    emailDomain: 'example.com',
    buildMime: (input) => {
      mimeInputs.push(input);
      return Buffer.from('RAW-MIME');
    },
    now: () => new Date('2026-07-17T12:00:00.000Z'),
    generateId: () => 'id-1',
    ...overrides,
  });
  return { service, ses, emails, mimeInputs };
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
  it('sends and records a valid message, passing bcc through the SES envelope', async () => {
    const { service, ses, emails } = makeService();

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
    expect(emails.records[0]).toMatchObject({
      id: 'id-1',
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: ['c@x.com'],
      bcc: ['b@x.com'],
      subject: 'Hi',
      sesMessageId: 'ses-msg-1',
      attachmentCount: 0,
      sizeBytes: Buffer.from('RAW-MIME').length,
    });
  });

  it('passes the display name to the MIME builder but never a bcc field', async () => {
    const { service, mimeInputs } = makeService();
    await service.send(request({ fromName: 'Me', bcc: ['b@x.com'] }));
    expect(mimeInputs[0]).toMatchObject({ from: 'me@example.com', fromName: 'Me' });
    expect(mimeInputs[0]).not.toHaveProperty('bcc');
  });

  it('accepts a sender under a subdomain of the configured domain', async () => {
    const { service, ses } = makeService();
    await service.send(request({ from: 'bot@mail.example.com' }));
    expect(ses.calls[0]?.from).toBe('bot@mail.example.com');
  });

  it('rejects a sender outside the configured domain with invalid_sender (no send)', async () => {
    const { service, ses } = makeService();
    await expect(service.send(request({ from: 'me@evil.com' }))).rejects.toMatchObject({
      code: 'invalid_sender',
      status: 400,
    });
    expect(ses.calls).toHaveLength(0);
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

  it('still succeeds when recording metadata fails (best-effort)', async () => {
    const emails = new FakeEmails();
    emails.fail = true;
    const { service, ses } = makeService({ emails });
    const result = await service.send(request());
    expect(result.messageId).toBe('ses-msg-1');
    expect(ses.calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });
});
