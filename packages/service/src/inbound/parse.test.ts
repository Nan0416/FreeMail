import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { InboundAttachmentDescriptor } from '../data/emails-repo.js';
import { parseInbound, type AttachmentSink, type ParseLimits } from './parse.js';

/** Records what the parser asked to store — the S3 write is faked. */
class FakeSink implements AttachmentSink {
  readonly stored: { partIndex: number; filename?: string; contentType: string; size: number }[] =
    [];
  store(
    partIndex: number,
    filename: string | undefined,
    contentType: string,
    bytes: Buffer,
  ): Promise<InboundAttachmentDescriptor> {
    this.stored.push({ partIndex, filename, contentType, size: bytes.length });
    return Promise.resolve({
      id: String(partIndex),
      filename: filename ?? 'attachment',
      contentType,
      sizeBytes: bytes.length,
      s3Key: `attachments/inbound/msg/${partIndex}`,
    });
  }
}

const mime = (lines: string[]): Readable => Readable.from(Buffer.from(lines.join('\r\n')));

const looseLimits = (over: Partial<ParseLimits> = {}): ParseLimits => ({
  maxParts: 1000,
  maxHeaderBlockBytes: 256 * 1024,
  maxAttachments: 25,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxAttachmentTotalBytes: 30 * 1024 * 1024,
  maxTextBodyBytes: 10 * 1024 * 1024,
  maxHtmlBodyBytes: 10 * 1024 * 1024,
  ...over,
});

const TEXT_PASS = [
  'X-SES-Spam-Verdict: PASS',
  'X-SES-Virus-Verdict: PASS',
  'From: Alice <a@x.com>',
  'To: b@y.com, c@y.com',
  'Subject: =?utf-8?q?caf=C3=A9?=',
  'Date: Wed, 01 Jan 2025 12:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello body text',
  '',
];

function attachmentMessage(virus: string): string[] {
  return [
    'X-SES-Spam-Verdict: PASS',
    `X-SES-Virus-Verdict: ${virus}`,
    'From: a@x.com',
    'Subject: With attachment',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'see attached',
    '--B',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'SGVsbG8gUERG', // "Hello PDF" (9 bytes)
    '--B--',
    '',
  ];
}

describe('parseInbound — clean text', () => {
  it('decodes headers, exposes a text snippet, extracts nothing', async () => {
    const p = await parseInbound(mime(TEXT_PASS), new FakeSink());
    expect(p.parseStatus).toBe('ok');
    expect(p.exposed).toBe(true);
    expect(p.from).toBe('a@x.com');
    expect(p.fromName).toBe('Alice');
    expect(p.to).toEqual(['b@y.com', 'c@y.com']);
    expect(p.subject).toBe('café'); // RFC 2047 encoded-word decoded
    expect(p.headerDate).toBe('2025-01-01T12:00:00.000Z');
    expect(p.textBody).toContain('Hello body text');
    expect(p.attachmentCount).toBe(0);
    expect(p.attachments).toEqual([]);
    expect(p.verdicts).toEqual({ spamVerdict: 'PASS', virusVerdict: 'PASS' });
  });
});

describe('parseInbound — html only', () => {
  it('retains the html body for the snippet path', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Spam-Verdict: PASS',
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Subject: HTML',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Hello <b>world</b></p>',
        '',
      ]),
      new FakeSink(),
    );
    expect(p.exposed).toBe(true);
    expect(p.htmlBody).toContain('Hello');
  });
});

describe('parseInbound — attachments', () => {
  it('extracts an attachment when virus is PASS', async () => {
    const sink = new FakeSink();
    const p = await parseInbound(mime(attachmentMessage('PASS')), sink);
    expect(p.parseStatus).toBe('ok');
    expect(p.exposed).toBe(true);
    expect(p.attachmentCount).toBe(1);
    expect(p.attachments).toHaveLength(1);
    expect(sink.stored).toHaveLength(1);
    expect(sink.stored[0]).toMatchObject({ contentType: 'application/pdf', size: 9 });
    expect(p.attachments[0]?.filename).toBe('report.pdf');
  });

  it('does NOT extract or expose anything when virus is FAIL (still counts the attachment)', async () => {
    const sink = new FakeSink();
    const p = await parseInbound(mime(attachmentMessage('FAIL')), sink);
    expect(p.exposed).toBe(false);
    expect(p.attachmentCount).toBe(1); // seen — reader learns there was an attachment
    expect(p.attachments).toEqual([]); // but nothing stored
    expect(sink.stored).toHaveLength(0);
    expect(p.textBody).toBeUndefined();
  });

  it('does NOT expose when the virus verdict is absent (no affirmative PASS)', async () => {
    const sink = new FakeSink();
    const p = await parseInbound(
      mime([
        'X-SES-Spam-Verdict: PASS',
        'From: a@x.com',
        'Subject: no virus header',
        'Content-Type: text/plain',
        '',
        'body',
        '',
      ]),
      sink,
    );
    expect(p.verdicts.virusVerdict).toBe('ABSENT');
    expect(p.exposed).toBe(false);
  });
});

describe('parseInbound — verdict forgery', () => {
  it('treats a duplicate/injected virus verdict as CONFLICTING → not exposed', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Virus-Verdict: PASS',
        'Received: smtp',
        'X-SES-Virus-Verdict: PASS', // injected duplicate
        'X-SES-Spam-Verdict: PASS',
        'From: a@x.com',
        'Content-Type: text/plain',
        '',
        'body',
        '',
      ]),
      new FakeSink(),
    );
    expect(p.verdicts.virusVerdict).toBe('CONFLICTING');
    expect(p.exposed).toBe(false);
  });

  it('spam is orthogonal: a duplicate SPAM verdict is CONFLICTING but virus PASS still exposes', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Spam-Verdict: PASS',
        'X-SES-Spam-Verdict: FAIL', // injected duplicate spam
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Content-Type: text/plain',
        '',
        'body',
        '',
      ]),
      new FakeSink(),
    );
    expect(p.verdicts.spamVerdict).toBe('CONFLICTING');
    expect(p.verdicts.virusVerdict).toBe('PASS');
    expect(p.exposed).toBe(true);
  });
});

describe('parseInbound — limits', () => {
  it('limit_exceeded on too many attachments', async () => {
    const sink = new FakeSink();
    const two = [
      'X-SES-Virus-Verdict: PASS',
      'From: a@x.com',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="a.bin"',
      '',
      'aaaa',
      '--B',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="b.bin"',
      '',
      'bbbb',
      '--B--',
      '',
    ];
    const p = await parseInbound(mime(two), sink, looseLimits({ maxAttachments: 1 }));
    expect(p.parseStatus).toBe('limit_exceeded');
    expect(p.exposed).toBe(false);
    expect(p.attachments).toEqual([]);
  });

  it('limit_exceeded on an oversized single attachment', async () => {
    const p = await parseInbound(
      mime(attachmentMessage('PASS')),
      new FakeSink(),
      looseLimits({ maxAttachmentBytes: 4 }), // "Hello PDF" is 9 bytes
    );
    expect(p.parseStatus).toBe('limit_exceeded');
  });

  it('limit_exceeded on total extracted bytes across attachments', async () => {
    const p = await parseInbound(
      mime(attachmentMessage('PASS')),
      new FakeSink(),
      looseLimits({ maxAttachmentTotalBytes: 4 }),
    );
    expect(p.parseStatus).toBe('limit_exceeded');
  });

  it('limit_exceeded on a multipart body with more than maxParts NON-attachment parts', async () => {
    // Six text/plain parts (which MailParser aggregates into ONE event) — event-counting
    // would miss this; the structural delimiter scan catches it.
    const many = [
      'X-SES-Virus-Verdict: PASS',
      'From: a@x.com',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
    ];
    for (let i = 0; i < 6; i++) many.push('--B', 'Content-Type: text/plain', '', `part ${i}`);
    many.push('--B--', '');
    const p = await parseInbound(mime(many), new FakeSink(), looseLimits({ maxParts: 3 }));
    expect(p.parseStatus).toBe('limit_exceeded');
    expect(p.exposed).toBe(false);
  });

  it('limit_exceeded on an oversized header block (no boundary within the cap)', async () => {
    const noBoundary = 'X-SES-Virus-Verdict: PASS\r\nX-Filler: ' + 'a'.repeat(64 * 1024);
    const p = await parseInbound(
      mime([noBoundary]),
      new FakeSink(),
      looseLimits({ maxHeaderBlockBytes: 8 * 1024 }),
    );
    expect(p.parseStatus).toBe('limit_exceeded');
  });

  it('limit_exceeded on an oversized plain-text body', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Content-Type: text/plain',
        '',
        'x'.repeat(20 * 1024),
        '',
      ]),
      new FakeSink(),
      looseLimits({ maxTextBodyBytes: 4 * 1024 }),
    );
    expect(p.parseStatus).toBe('limit_exceeded');
    expect(p.exposed).toBe(false);
  });

  it('limit_exceeded on an oversized HTML body', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Content-Type: text/html',
        '',
        '<p>' + 'a'.repeat(20 * 1024) + '</p>',
        '',
      ]),
      new FakeSink(),
      looseLimits({ maxHtmlBodyBytes: 4 * 1024 }),
    );
    expect(p.parseStatus).toBe('limit_exceeded');
    expect(p.exposed).toBe(false);
  });
});

describe('parseInbound — hostile / degenerate input', () => {
  it('does not throw on non-MIME garbage — produces a bounded record', async () => {
    const p = await parseInbound(
      mime(['this is not a real email', '', 'just some bytes', '']),
      new FakeSink(),
    );
    expect(['ok', 'parse_failed']).toContain(p.parseStatus);
    expect(typeof p.from).toBe('string');
    expect(Array.isArray(p.to)).toBe(true);
  });

  it('keeps an attacker Date as display-only (does not fail), preserving the raw value', async () => {
    const p = await parseInbound(
      mime([
        'X-SES-Virus-Verdict: PASS',
        'From: a@x.com',
        'Date: Fri, 01 Jan 2100 00:00:00 +0000',
        'Content-Type: text/plain',
        '',
        'body',
        '',
      ]),
      new FakeSink(),
    );
    expect(p.headerDate).toBe('2100-01-01T00:00:00.000Z');
  });

  it('propagates an infra (source-stream) error as a rejection so it can retry', async () => {
    const bad = new Readable({
      read() {
        this.destroy(new Error('s3 read blew up'));
      },
    });
    await expect(parseInbound(bad, new FakeSink())).rejects.toThrow('s3 read blew up');
  });
});
