import { describe, expect, it } from 'vitest';
import { headerValues, parseHeaderLines } from '../../src/inbound/headers.js';

describe('parseHeaderLines', () => {
  it('parses ordered lowercased keys + trimmed values', () => {
    const lines = parseHeaderLines('From: a@b.com\r\nSubject: Hi\r\nX-Foo: bar');
    expect(lines).toEqual([
      { key: 'from', value: 'a@b.com' },
      { key: 'subject', value: 'Hi' },
      { key: 'x-foo', value: 'bar' },
    ]);
  });

  it('preserves duplicate headers in source order', () => {
    const lines = parseHeaderLines(
      'X-SES-Spam-Verdict: FAIL\r\nReceived: x\r\nX-SES-Spam-Verdict: PASS',
    );
    expect(headerValues(lines, 'x-ses-spam-verdict')).toEqual(['FAIL', 'PASS']);
  });

  it('unfolds RFC 5322 continuation lines', () => {
    const lines = parseHeaderLines('Subject: hello\r\n  world\r\nTo: x@y.com');
    expect(lines[0]).toEqual({ key: 'subject', value: 'hello world' });
    expect(lines[1]).toEqual({ key: 'to', value: 'x@y.com' });
  });

  it('skips lines without a colon', () => {
    expect(parseHeaderLines('garbage-no-colon\r\nFrom: a@b.com')).toEqual([
      { key: 'from', value: 'a@b.com' },
    ]);
  });

  it('tolerates a trailing header/body separator line', () => {
    // mailsplit's getHeaders() ends the block with a blank separator line.
    expect(parseHeaderLines('From: a@b.com\r\nSubject: Hi\r\n\r\n')).toEqual([
      { key: 'from', value: 'a@b.com' },
      { key: 'subject', value: 'Hi' },
    ]);
  });
});
