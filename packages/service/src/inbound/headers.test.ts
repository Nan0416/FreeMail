import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HeaderCaptureStream, headerValues, parseHeaderLines } from './headers.js';

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
});

describe('HeaderCaptureStream', () => {
  async function capture(raw: string): Promise<string> {
    const stream = new HeaderCaptureStream();
    const sink: Buffer[] = [];
    stream.on('data', (c: Buffer) => sink.push(c));
    Readable.from(Buffer.from(raw)).pipe(stream);
    await new Promise((resolve) => stream.on('end', resolve));
    return stream.block;
  }

  it('captures the header block up to the blank line and passes bytes through unchanged', async () => {
    const raw = 'From: a@b.com\r\nSubject: Hi\r\n\r\nbody bytes here';
    const stream = new HeaderCaptureStream();
    const passed: Buffer[] = [];
    stream.on('data', (c: Buffer) => passed.push(c));
    Readable.from(Buffer.from(raw)).pipe(stream);
    await new Promise((resolve) => stream.on('end', resolve));
    expect(stream.block).toBe('From: a@b.com\r\nSubject: Hi');
    expect(Buffer.concat(passed).toString()).toBe(raw); // nothing withheld/altered
  });

  it('handles LF-only separators', async () => {
    expect(await capture('From: a@b.com\nSubject: Hi\n\nbody')).toBe('From: a@b.com\nSubject: Hi');
  });

  it('bounds the captured block when no boundary is ever seen', async () => {
    const noBoundary = 'X-Header: ' + 'a'.repeat(1024 * 1024); // 1 MB, no blank line
    const block = await capture(noBoundary);
    expect(block.length).toBeLessThanOrEqual(256 * 1024);
  });
});
