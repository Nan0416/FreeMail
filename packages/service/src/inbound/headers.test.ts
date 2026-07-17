import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { InboundScanStream, headerValues, parseHeaderLines, type ScanLimits } from './headers.js';

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

describe('InboundScanStream', () => {
  const LIMITS: ScanLimits = { maxParts: 200, maxHeaderBlockBytes: 256 * 1024 };

  /** Drive the scan stream over `raw` in one or more chunks; return the block, passthrough, and any breach. */
  async function scan(
    raw: string,
    limits: ScanLimits = LIMITS,
    chunkSize?: number,
  ): Promise<{ block: string; passed: string; breach?: string }> {
    const stream = new InboundScanStream(limits);
    const passed: Buffer[] = [];
    let breach: string | undefined;
    stream.on('data', (c: Buffer) => passed.push(c));
    stream.on('breach', (reason: string) => (breach = reason));
    const buf = Buffer.from(raw);
    const src = chunkSize ? Readable.from(chunkBuffer(buf, chunkSize)) : Readable.from(buf);
    src.pipe(stream);
    await new Promise((resolve) => stream.on('end', resolve));
    return { block: stream.block, passed: Buffer.concat(passed).toString(), breach };
  }

  it('captures the header block up to the blank line and passes bytes through unchanged', async () => {
    const raw = 'From: a@b.com\r\nSubject: Hi\r\n\r\nbody bytes here';
    const { block, passed } = await scan(raw);
    expect(block).toBe('From: a@b.com\r\nSubject: Hi');
    expect(passed).toBe(raw); // nothing withheld/altered
  });

  it('handles LF-only separators', async () => {
    const { block } = await scan('From: a@b.com\nSubject: Hi\n\nbody');
    expect(block).toBe('From: a@b.com\nSubject: Hi');
  });

  it('breaches (oversized header attack) when no boundary is seen within the cap', async () => {
    const noBoundary = 'X-Header: ' + 'a'.repeat(300 * 1024); // no blank line, over the cap
    const { breach } = await scan(noBoundary);
    expect(breach).toBe('header block too large');
  });

  it('counts MIME boundary delimiters structurally and breaches over maxParts', async () => {
    // 6 parts → 7 `--boundary` delimiter lines; cap at 3 → breach.
    const parts = ['From: a@b.com', 'Content-Type: multipart/mixed; boundary="B"', ''];
    for (let i = 0; i < 6; i++) parts.push('--B', 'Content-Type: text/plain', '', `part ${i}`);
    parts.push('--B--', '');
    const { breach } = await scan(parts.join('\r\n'), {
      maxParts: 3,
      maxHeaderBlockBytes: 256 * 1024,
    });
    expect(breach).toBe('too many MIME parts');
  });

  it('counts delimiters correctly when a \\n-- split straddles a chunk boundary', async () => {
    const parts = ['From: a@b.com', 'Content-Type: multipart/mixed; boundary="B"', ''];
    for (let i = 0; i < 6; i++) parts.push('--B', 'Content-Type: text/plain', '', `part ${i}`);
    parts.push('--B--', '');
    // 1-byte chunks force every `\n--` to straddle chunk boundaries.
    const { breach } = await scan(
      parts.join('\r\n'),
      { maxParts: 3, maxHeaderBlockBytes: 256 * 1024 },
      1,
    );
    expect(breach).toBe('too many MIME parts');
  });
});

function* chunkBuffer(buf: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
