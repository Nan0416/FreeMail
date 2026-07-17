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
