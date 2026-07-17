import { describe, expect, it } from 'vitest';
import { buildRawMime } from './mime.js';

describe('buildRawMime', () => {
  it('emits From/To/Cc/Subject and both body parts, but never a Bcc header', () => {
    const raw = buildRawMime({
      from: 'sender@example.com',
      fromName: 'Sender Name',
      to: ['to@example.net'],
      cc: ['cc@example.net'],
      subject: 'Hello there',
      text: 'plain body',
      html: '<p>html body</p>',
      attachments: [],
    }).toString('utf8');

    expect(raw).toMatch(/^From: .*sender@example\.com/m);
    // The display name is carried as an RFC-2047 encoded-word (mimetext base64-encodes header words).
    expect(raw).toContain(Buffer.from('Sender Name').toString('base64'));
    expect(raw).toMatch(/^To: .*to@example\.net/m);
    expect(raw).toMatch(/^Cc: .*cc@example\.net/m);
    expect(raw).toMatch(/^Subject: /m);
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
    // BCC must never appear in the message — blind recipients ride the SES envelope.
    expect(raw).not.toMatch(/^Bcc:/im);
  });

  it('embeds an attachment as base64', () => {
    const raw = buildRawMime({
      from: 'sender@example.com',
      to: ['to@example.net'],
      cc: [],
      subject: 'With file',
      text: 'see attached',
      attachments: [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          contentBase64: Buffer.from('hello file').toString('base64'),
        },
      ],
    }).toString('utf8');

    expect(raw).toContain('note.txt');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toMatch(/Content-Transfer-Encoding: base64/i);
  });
});
