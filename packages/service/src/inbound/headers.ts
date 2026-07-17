/**
 * Capturing and parsing the RAW leading header block of the message, independent of
 * the MIME body parser. SES prepends its `X-SES-*-Verdict` headers, so its verdict
 * is the FIRST occurrence of that header line; an attacker can inject their own
 * `X-SES-Spam-Verdict: PASS` lower in the message. Reading verdicts from the ordered
 * raw header lines (not a header map that could surface a spoofed later value) and
 * taking the first occurrence — with a duplicate treated as tampering — is the
 * mitigation. The capture is bounded ({@link MAX_HEADER_BLOCK_BYTES}) so a message
 * with no header/body boundary can't grow it without limit.
 */
import { Transform, type TransformCallback } from 'node:stream';
import { MAX_HEADER_BLOCK_BYTES } from './limits.js';

/** One parsed header line: lowercased key + its unfolded value, in source order. */
export interface HeaderLine {
  key: string;
  value: string;
}

/**
 * A pass-through transform that tees the leading bytes into a bounded buffer up to
 * the header/body boundary (a blank line), then stops capturing. Bytes flow through
 * unchanged to the downstream MIME parser — nothing is withheld or altered.
 */
export class HeaderCaptureStream extends Transform {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private done = false;
  /** The raw header block (without the trailing blank line), available once the stream ends. */
  block = '';

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.done) {
      this.chunks.push(chunk);
      this.captured += chunk.length;
      const joined = Buffer.concat(this.chunks);
      const boundary = headerBodyBoundary(joined);
      if (boundary >= 0) {
        this.block = joined.subarray(0, boundary).toString('utf8');
        this.finishCapture();
      } else if (this.captured >= MAX_HEADER_BLOCK_BYTES) {
        this.block = joined.subarray(0, MAX_HEADER_BLOCK_BYTES).toString('utf8');
        this.finishCapture();
      }
    }
    cb(null, chunk);
  }

  private finishCapture(): void {
    this.done = true;
    this.chunks.length = 0; // release the buffered prefix
  }
}

/** Index of the CRLFCRLF / LFLF header/body separator, or -1 if not yet seen. */
function headerBodyBoundary(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
}

/**
 * Parse a raw header block into ordered {@link HeaderLine}s. RFC 5322 folding is
 * unfolded (a line starting with a space/tab continues the previous header). A line
 * with no colon is skipped. Keys are lowercased; values are trimmed.
 */
export function parseHeaderLines(block: string): HeaderLine[] {
  const physical = block.split(/\r\n|\n|\r/);
  const logical: string[] = [];
  for (const line of physical) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) {
      logical[logical.length - 1] += ' ' + line.trim();
    } else {
      logical.push(line);
    }
  }
  const out: HeaderLine[] = [];
  for (const line of logical) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out.push({
      key: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    });
  }
  return out;
}

/** All values (in order) for a header name — used to detect duplicates + take the first. */
export function headerValues(lines: readonly HeaderLine[], name: string): string[] {
  const lower = name.toLowerCase();
  return lines.filter((l) => l.key === lower).map((l) => l.value);
}
