import { describe, expect, it } from 'vitest';
import { buildRawMime } from './mime.js';

describe('buildRawMime', () => {
  it('emits From/To/Cc/Subject and both body parts', async () => {
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        fromName: 'Sender Name',
        to: ['to@example.net'],
        cc: ['cc@example.net'],
        bcc: [],
        subject: 'Hello there',
        text: 'plain body',
        html: '<p>html body</p>',
        attachments: [],
      })
    ).toString('utf8');

    expect(raw).toMatch(/^From: Sender Name <sender@example\.com>/m);
    expect(raw).toMatch(/^To: to@example\.net/m);
    expect(raw).toMatch(/^Cc: cc@example\.net/m);
    expect(raw).toMatch(/^Subject: Hello there/m);
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
  });

  it('never leaks a bcc recipient into the composed MIME (keepBcc=false)', async () => {
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        to: ['to@example.net'],
        cc: [],
        bcc: ['secret@hidden.net'],
        subject: 'Confidential',
        text: 'body',
        attachments: [],
      })
    ).toString('utf8');

    // The bcc was passed to the builder but must appear neither as a header nor anywhere in the message.
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toContain('secret@hidden.net');
  });

  it('encodes a non-ASCII body with a real transfer encoding (never 7bit)', async () => {
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        to: ['to@example.net'],
        cc: [],
        bcc: [],
        subject: '你好 📧',
        text: '你好 📧 world',
        attachments: [],
      })
    ).toString('utf8');

    // A UTF-8 body must not be emitted as 7bit — nodemailer picks quoted-printable/base64.
    expect(raw).toMatch(/Content-Transfer-Encoding: (quoted-printable|base64)/i);
    expect(raw).not.toMatch(/text\/plain[\s\S]*?Content-Transfer-Encoding: 7bit/i);
    // The subject is carried as an RFC-2047 encoded-word, not raw UTF-8 in the header.
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/im);
  });

  it('safely encodes a hostile attachment filename (quote + CRLF + non-ASCII, no injection)', async () => {
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        to: ['to@example.net'],
        cc: [],
        bcc: [],
        subject: 'x',
        text: 'body',
        attachments: [
          {
            // Quote, CRLF+header, and non-ASCII bytes all in one filename.
            filename: '"\r\nX-Injected: yes\r\nnamé你.txt',
            contentType: 'application/octet-stream',
            contentBase64: Buffer.from('data').toString('base64'),
          },
        ],
      })
    ).toString('utf8');

    // The CRLF+header in the filename must not break out into a real header.
    expect(raw).not.toMatch(/^X-Injected:/im);
    expect(raw).not.toContain('\r\nX-Injected: yes');
    // Non-ASCII bytes must be encoded (RFC 2231 / encoded-word), never emitted raw in a header.
    expect(raw).not.toContain('namé你');
    expect(raw).toMatch(/filename\*0?\*?=/i);
  });

  it('round-trips attachment bytes (decode the output part == input bytes)', async () => {
    // All byte values, large enough that the base64 wraps across lines.
    const content = Buffer.from(Array.from({ length: 180 }, (_, i) => (i * 7 + 3) % 256));
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        to: ['to@example.net'],
        cc: [],
        bcc: [],
        subject: 'bin',
        text: 'see attached',
        attachments: [
          {
            filename: 'f.bin',
            contentType: 'application/octet-stream',
            contentBase64: content.toString('base64'),
          },
        ],
      })
    ).toString('utf8');

    // Pull the base64 payload out of the composed message and decode it back.
    const match = raw.match(
      /application\/octet-stream[\s\S]*?\r\n\r\n([A-Za-z0-9+/\r\n=]+?)\r\n--/,
    );
    expect(match).not.toBeNull();
    const decoded = Buffer.from((match?.[1] ?? '').replace(/[\r\n]/g, ''), 'base64');
    expect(decoded.equals(content)).toBe(true);
  });

  it('embeds an attachment as base64', async () => {
    const content = Buffer.from('hello file');
    const raw = (
      await buildRawMime({
        from: 'sender@example.com',
        to: ['to@example.net'],
        cc: [],
        bcc: [],
        subject: 'With file',
        text: 'see attached',
        attachments: [
          {
            filename: 'note.txt',
            contentType: 'text/plain',
            contentBase64: content.toString('base64'),
          },
        ],
      })
    ).toString('utf8');

    expect(raw).toContain('note.txt');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain(content.toString('base64'));
  });
});
