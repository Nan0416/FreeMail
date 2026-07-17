import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BodyLimiter, RawByteLimiter } from './stream-limits.js';

/** A mailsplit-shaped node chunk. */
function node(
  contentType: string | false,
  opts: { root?: boolean; multipart?: string | false; headers?: string } = {},
) {
  return {
    type: 'node' as const,
    root: opts.root ?? false,
    multipart: opts.multipart ?? false,
    contentType,
    getHeaders: () => Buffer.from(opts.headers ?? ''),
  };
}
const body = (n: number) => ({ type: 'body' as const, value: Buffer.alloc(n) });

describe('RawByteLimiter', () => {
  it('passes bytes through and breaches past the cap', async () => {
    const limiter = new RawByteLimiter(10);
    const passed: Buffer[] = [];
    let breached = false;
    limiter.on('data', (c: Buffer) => passed.push(c));
    limiter.on('breach', () => (breached = true));
    Readable.from([Buffer.alloc(6), Buffer.alloc(6)]).pipe(limiter);
    await new Promise((r) => limiter.on('end', r));
    expect(breached).toBe(true);
    expect(Buffer.concat(passed).length).toBe(12); // still passed through unchanged
  });

  it('does not breach at or under the cap', async () => {
    const limiter = new RawByteLimiter(10);
    let breached = false;
    limiter.on('data', () => {});
    limiter.on('breach', () => (breached = true));
    Readable.from([Buffer.alloc(10)]).pipe(limiter);
    await new Promise((r) => limiter.on('end', r));
    expect(breached).toBe(false);
  });
});

describe('BodyLimiter', () => {
  async function run(
    chunks: unknown[],
    limits = { maxTextBodyBytes: 100, maxHtmlBodyBytes: 100, maxTotalBodyBytes: 10_000 },
  ) {
    const limiter = new BodyLimiter(limits);
    const out: unknown[] = [];
    let breach: string | undefined;
    limiter.on('data', (c) => out.push(c));
    limiter.on('breach', (r: string) => (breach = r));
    Readable.from(chunks, { objectMode: true }).pipe(limiter);
    await new Promise((r) => limiter.on('end', r));
    return { limiter, out, breach };
  }

  it('captures the root node header block for verdicts', async () => {
    const { limiter } = await run([
      node('multipart/mixed', {
        root: true,
        multipart: 'mixed',
        headers: 'X-SES-Virus-Verdict: PASS\r\n\r\n',
      }),
    ]);
    expect(limiter.rootHeaderBlock).toContain('X-SES-Virus-Verdict: PASS');
  });

  it('caps a text/plain node body and breaches past the per-node cap', async () => {
    const { breach } = await run([node('text/plain'), body(60), body(60)]);
    expect(breach).toBe('text/html body exceeds per-node size cap');
  });

  it('caps text/html independently', async () => {
    const { breach } = await run([node('text/html'), body(150)], {
      maxTextBodyBytes: 1000,
      maxHtmlBodyBytes: 100,
      maxTotalBodyBytes: 10_000,
    });
    expect(breach).toBe('text/html body exceeds per-node size cap');
  });

  it('breaches on the CUMULATIVE budget across many under-per-node-cap text nodes', async () => {
    // Each node is 60 bytes (under the 100 per-node cap), but 4×60=240 > 200 total budget.
    const chunks = [
      node('text/plain'),
      body(60),
      node('text/plain'),
      body(60),
      node('text/plain'),
      body(60),
      node('text/plain'),
      body(60),
    ];
    const { breach } = await run(chunks, {
      maxTextBodyBytes: 100,
      maxHtmlBodyBytes: 100,
      maxTotalBodyBytes: 200,
    });
    expect(breach).toBe('cumulative text/html body exceeds message budget');
  });

  it('does NOT cap attachment (non-text) node bodies — they have their own caps', async () => {
    const { breach, out } = await run([
      node('application/pdf', { multipart: false }),
      body(10_000),
    ]);
    expect(breach).toBeUndefined();
    expect(out).toHaveLength(2); // passed through
  });

  it('resets the counter per leaf node (two small text parts do not accumulate)', async () => {
    const { breach } = await run([node('text/plain'), body(60), node('text/plain'), body(60)]);
    expect(breach).toBeUndefined(); // each 60 ≤ 100; not summed across nodes
  });

  it('passes every chunk through unchanged', async () => {
    const chunks = [node('text/plain'), body(10)];
    const { out } = await run(chunks);
    expect(out).toEqual(chunks);
  });
});
