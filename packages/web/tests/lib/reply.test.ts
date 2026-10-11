import { describe, expect, it } from 'vitest';
import type { EmailDetail } from '@freemail/shared';
import { buildPrefill, quotedText, replySender, replyToElsewhere } from '../../src/lib/reply.js';

const INBOUND: EmailDetail = {
  id: 'h1',
  direction: 'inbound',
  from: 'alice@x.com',
  fromName: 'Alice',
  to: ['me@mine.dev', 'bob@x.com'],
  cc: ['carol@x.com', 'ME@mine.dev'],
  subject: 'Plans',
  date: '2026-07-17T00:00:00.000Z',
  text: 'line one\nline two\n\n<b>not markup</b>',
  attachments: [],
  hasAttachments: false,
  attachmentCount: 0,
  sizeBytes: 10,
};

describe('buildPrefill', () => {
  it('replies to the sender from the address the mail reached', () => {
    const p = buildPrefill(INBOUND, 'reply', 'old@mine.dev');
    expect(p.from).toBe('me@mine.dev');
    expect(p.to).toBe('alice@x.com');
    expect(p.cc).toBe('');
    expect(p.subject).toBe('Re: Plans');
  });

  it('reply-all copies the other recipients, minus ourselves and the sender', () => {
    const p = buildPrefill(INBOUND, 'replyAll', 'me@mine.dev');
    expect(p.to).toBe('alice@x.com');
    expect(p.cc).toBe('bob@x.com, carol@x.com');
  });

  it('does not stack prefixes', () => {
    expect(buildPrefill({ ...INBOUND, subject: 'RE: Plans' }, 'reply', '').subject).toBe(
      'RE: Plans',
    );
    expect(buildPrefill({ ...INBOUND, subject: 'Fwd: Plans' }, 'forward', '').subject).toBe(
      'Fwd: Plans',
    );
  });

  it('forwards with no recipients and a forwarded-message header', () => {
    const p = buildPrefill(INBOUND, 'forward', 'me@mine.dev');
    expect(p.to).toBe('');
    expect(p.subject).toBe('Fwd: Plans');
    expect(p.html).toContain('Forwarded message');
    expect(p.html).toContain('Alice &lt;alice@x.com&gt;');
  });

  it('quotes the body as escaped text, never as markup', () => {
    const p = buildPrefill(INBOUND, 'reply', '');
    expect(p.html).toContain(
      '<blockquote><p>line one<br>line two</p><p>&lt;b&gt;not markup&lt;/b&gt;</p></blockquote>',
    );
  });

  it('escapes the sender display name, which is untrusted inbound data', () => {
    const p = buildPrefill(
      { ...INBOUND, fromName: '<a href="https://evil.example">Al</a>' },
      'reply',
      '',
    );
    expect(p.html).not.toContain('<a href');
    expect(p.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Al&lt;/a&gt;');
  });

  it('threads a reply to the original, but not a forward', () => {
    expect(buildPrefill(INBOUND, 'reply', '').inReplyTo).toBe('h1');
    expect(buildPrefill(INBOUND, 'replyAll', '').inReplyTo).toBe('h1');
    expect(buildPrefill(INBOUND, 'forward', '').inReplyTo).toBeUndefined();
  });

  it("replies to the sender's Reply-To when there is one", () => {
    const p = buildPrefill({ ...INBOUND, replyTo: ['desk@x.com'] }, 'replyAll', 'me@mine.dev');
    expect(p.to).toBe('desk@x.com');
    expect(p.cc).toBe('bob@x.com, carol@x.com');
  });

  it('continues a sent message to its recipients', () => {
    const sent: EmailDetail = { ...INBOUND, direction: 'sent', from: 'me@mine.dev', cc: [] };
    const p = buildPrefill(sent, 'reply', '');
    expect(p.from).toBe('me@mine.dev');
    expect(p.to).toBe('me@mine.dev, bob@x.com');
  });
});

describe('quotedText', () => {
  it('extracts text from HTML without rendering it', () => {
    const email = {
      ...INBOUND,
      text: undefined,
      html: '<p>Hi <img src="https://t.example/p.gif">there</p>',
    };
    expect(quotedText(email)).toBe('Hi there');
  });
});

describe('replySender', () => {
  it('falls back to the last sender, then the first recipient', () => {
    expect(replySender({ ...INBOUND, to: ['x@other.com'], cc: [] }, 'me@mine.dev')).toBe(
      'me@mine.dev',
    );
    expect(replySender({ ...INBOUND, to: ['x@other.com'], cc: [] }, '')).toBe('x@other.com');
  });
});

describe('replyToElsewhere', () => {
  it("flags a received message whose Reply-To leaves the sender's domain", () => {
    expect(replyToElsewhere({ ...INBOUND, replyTo: ['pay@evil.test'] })).toBe(true);
  });

  it("does not flag a Reply-To on the sender's own domain, or none", () => {
    expect(replyToElsewhere({ ...INBOUND, replyTo: ['desk@X.com'] })).toBe(false);
    expect(replyToElsewhere(INBOUND)).toBe(false);
  });

  it('never flags our own sent mail', () => {
    expect(replyToElsewhere({ ...INBOUND, direction: 'sent', replyTo: ['a@other.test'] })).toBe(
      false,
    );
  });
});
