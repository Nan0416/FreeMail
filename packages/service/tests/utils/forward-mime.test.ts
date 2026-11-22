import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { FORWARDED_MARKER_HEADER, SENDER_UNVERIFIED_HEADER, buildForwardedMime } from '../../src/utils/forward-mime.js';
import { parseHeaderLines, headerValues } from '../../src/utils/inbound-headers.js';

const HEADERS = [
  'Return-Path: <bounce@customer.com>',
  'Received: from mail.customer.com by inbound-smtp.us-east-1.amazonaws.com',
  'X-SES-Spam-Verdict: PASS',
  'X-SES-Virus-Verdict: PASS',
  'Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=customer.com;',
  ' dkim=pass header.i=@customer.com; dmarc=pass header.from=customer.com;',
  'Received-SPF: pass (spfCheck: domain of customer.com designates 1.2.3.4 as permitted sender)',
  'X-SES-RECEIPT: AEFBQUFBQUFB',
  'DKIM-Signature: v=1; a=rsa-sha256; d=customer.com;',
  '\th=from:to:subject; bh=abc=; b=def=',
  'From: Alice Smith <alice@customer.com>',
  'Sender: alice@customer.com',
  'To: R123@returns.amazon.com',
  'Cc: returns@warehouse.example',
  'Subject: Return R123',
  'Message-ID: <orig-1@customer.com>',
  'Date: Fri, 13 Nov 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
];
const BODY = 'Body line 1\r\nBody ünïcode line 2\r\n';

function rawMessage(headers: readonly string[] = HEADERS, eol = '\r\n', body = BODY): Buffer {
  return Buffer.from(`${headers.join(eol)}${eol}${eol}${body}`, 'utf8');
}

function forward(raw: Buffer, overrides: { from?: string; fromName?: string; senderVerified?: boolean } = {}): Buffer {
  const out = buildForwardedMime({
    raw,
    forwarderAddress: 'forwarding@warehouse.example',
    forwarderLabel: 'warehouse.example',
    from: 'alice@customer.com',
    fromName: 'Alice Smith',
    messageId: 'msg-1',
    senderVerified: true,
    ...overrides,
  });
  if (out === undefined) {
    throw new Error('expected a forwarded copy');
  }
  return out;
}

function headersOf(message: Buffer): ReturnType<typeof parseHeaderLines> {
  const end = message.indexOf('\r\n\r\n') >= 0 ? message.indexOf('\r\n\r\n') : message.indexOf('\n\n');
  return parseHeaderLines(message.subarray(0, end).toString('latin1'));
}

describe('buildForwardedMime', () => {
  it('sends From the forwarding address, naming the original sender, with Reply-To them', async () => {
    const parsed = await simpleParser(forward(rawMessage()));

    expect(parsed.from?.value).toEqual([
      {
        name: 'Alice Smith (alice@customer.com) via warehouse.example',
        address: 'forwarding@warehouse.example',
      },
    ]);
    expect(parsed.replyTo?.value).toEqual([{ name: 'Alice Smith', address: 'alice@customer.com' }]);
    expect(parsed.subject).toBe('Return R123');
    expect(parsed.text).toBe('Body line 1\nBody ünïcode line 2\n');
  });

  it('copies everything after the header block byte for byte', () => {
    const raw = rawMessage();
    const out = forward(raw);

    expect(out.subarray(out.indexOf('\r\n\r\n'))).toEqual(raw.subarray(raw.indexOf('\r\n\r\n')));
  });

  it('drops the sender, SES receipt, and signature headers — folded lines included — and keeps the rest', () => {
    const out = forward(rawMessage());
    const lines = headersOf(out);
    const names = lines.map((line) => line.key);

    for (const dropped of ['return-path', 'sender', 'message-id', 'dkim-signature', 'authentication-results', 'received-spf', 'x-ses-spam-verdict', 'x-ses-virus-verdict', 'x-ses-receipt']) {
      expect(names).not.toContain(dropped);
    }
    expect(out.toString('latin1')).not.toContain('bh=abc=');
    expect(out.toString('latin1')).not.toContain('dmarc=pass');
    for (const kept of ['received', 'to', 'cc', 'subject', 'date', 'mime-version', 'content-type']) {
      expect(names).toContain(kept);
    }
    expect(headerValues(lines, 'from')).toHaveLength(1);
    expect(headerValues(lines, FORWARDED_MARKER_HEADER)).toEqual(['msg-1']);
  });

  it('keeps a Reply-To the message already had, and adds none', async () => {
    const raw = rawMessage([...HEADERS, 'Reply-To: support@customer.com']);
    const out = forward(raw);

    expect(headerValues(headersOf(out), 'reply-to')).toEqual(['support@customer.com']);
    expect((await simpleParser(out)).replyTo?.value).toEqual([{ name: '', address: 'support@customer.com' }]);
  });

  it('keeps 8-bit header bytes untouched', () => {
    const subject = Buffer.from('Subject: Rücksendung', 'utf8');
    const raw = rawMessage(HEADERS.map((h) => (h.startsWith('Subject:') ? 'Subject: Rücksendung' : h)));

    expect(forward(raw).includes(subject)).toBe(true);
  });

  it('keeps an LF-only message LF-only', () => {
    const raw = rawMessage(HEADERS, '\n', 'Body\n');
    const out = forward(raw);

    expect(out.includes('\r')).toBe(false);
    expect(out.subarray(out.indexOf('\n\n')).toString()).toBe('\n\nBody\n');
  });

  it('encodes a non-ASCII display name as RFC 2047 words', async () => {
    const out = forward(rawMessage(), { fromName: 'Jöhn Dœ' });

    expect(headerValues(headersOf(out), 'from')[0]).toMatch(/^=\?UTF-8\?B\?/);
    expect((await simpleParser(out)).from?.value[0]?.name).toBe('Jöhn Dœ (alice@customer.com) via warehouse.example');
  });

  it('escapes quotes and backslashes in an ASCII display name', async () => {
    const out = forward(rawMessage(), { fromName: 'Al "The \\ Pal" Smith' });

    expect((await simpleParser(out)).from?.value[0]?.name).toBe('Al "The \\ Pal" Smith (alice@customer.com) via warehouse.example');
  });

  it('uses the address alone when there is no display name', async () => {
    const out = forward(rawMessage(), { fromName: '' });
    const parsed = await simpleParser(out);

    expect(parsed.from?.value[0]?.name).toBe('alice@customer.com via warehouse.example');
    expect(parsed.replyTo?.value).toEqual([{ name: '', address: 'alice@customer.com' }]);
  });

  it('writes no Reply-To for a From that is not a plain address', () => {
    const out = forward(rawMessage(), { from: 'weird <address>', fromName: 'Alice' });

    expect(headerValues(headersOf(out), 'reply-to')).toEqual([]);
    expect(headerValues(headersOf(out), 'from')[0]).toBe('"Alice via warehouse.example" <forwarding@warehouse.example>');
  });

  it('returns undefined for a message with no header block', () => {
    expect(
      buildForwardedMime({
        raw: Buffer.from('From: a@b.example'),
        forwarderAddress: 'forwarding@warehouse.example',
        forwarderLabel: 'warehouse.example',
        from: 'a@b.example',
        messageId: 'msg-1',
        senderVerified: true,
      }),
    ).toBeUndefined();
  });

  it('says so when the sender is unverified: "(unverified)" in the From name and a header', () => {
    const out = forward(rawMessage(), { senderVerified: false });
    const lines = headersOf(out);
    expect(headerValues(lines, 'from')).toEqual(['"Alice Smith (alice@customer.com) (unverified) via warehouse.example" <forwarding@warehouse.example>']);
    expect(headerValues(lines, SENDER_UNVERIFIED_HEADER)).toEqual(['no']);
  });

  it('adds no verification header for a verified sender', () => {
    expect(headerValues(headersOf(forward(rawMessage())), SENDER_UNVERIFIED_HEADER)).toEqual([]);
  });

  it('drops a sender-verified header the message brought with it (only the forwarder may say)', () => {
    const forged = rawMessage([...HEADERS, `${SENDER_UNVERIFIED_HEADER}: yes`]);
    expect(headerValues(headersOf(forward(forged)), SENDER_UNVERIFIED_HEADER)).toEqual([]);
    expect(headerValues(headersOf(forward(forged, { senderVerified: false })), SENDER_UNVERIFIED_HEADER)).toEqual(['no']);
  });

  it('treats a bare CR as a line break, so a header smuggled after one is dropped like any other', () => {
    const smuggled = rawMessage([...HEADERS.slice(0, -1), 'X-Note: hi\rX-SES-Configuration-Set: theirs', HEADERS[HEADERS.length - 1]!]);
    const out = forward(smuggled);
    expect(out.toString('latin1')).not.toContain('X-SES-Configuration-Set');
    expect(out.toString('latin1')).not.toContain('\r\r');
    expect(headerValues(headersOf(out), 'x-note')).toEqual(['hi']);
  });
});
