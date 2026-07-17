/**
 * Scanning the RAW byte stream of the message, independent of the MIME body parser.
 * Does three things as bytes flow through UNCHANGED to the downstream parser:
 *
 *  1. Captures the leading header block (up to the first blank line) so verdicts can
 *     be read from the ordered raw header lines. SES prepends its `X-SES-*-Verdict`
 *     headers, so its verdict is the FIRST occurrence; an attacker can inject their
 *     own lower down. Reading first-occurrence from the raw lines — with a duplicate
 *     treated as tampering — is the mitigation.
 *  2. Enforces a header-block size limit: a message that never reaches a header/body
 *     boundary within {@link MAX_HEADER_BLOCK_BYTES} is an oversized-header attack →
 *     it breaches (rather than silently truncating verdict capture).
 *  3. Counts MIME boundary-delimiter lines (`--…`) structurally over the raw bytes —
 *     NOT parser events, which aggregate all text parts into one — so a message with
 *     more than `maxParts` parts breaches. Streaming MailParser can't report this.
 *
 * A breach emits `'breach'` with a reason; the parser orchestrator degrades to a
 * bounded quarantine on it.
 */
import { Transform, type TransformCallback } from 'node:stream';

/** One parsed header line: lowercased key + its unfolded value, in source order. */
export interface HeaderLine {
  key: string;
  value: string;
}

export interface ScanLimits {
  /** Max boundary-delimiter lines before the message is treated as hostile. */
  maxParts: number;
  /** Max bytes to buffer looking for the header/body boundary before it's an oversized-header attack. */
  maxHeaderBlockBytes: number;
}

/** ASCII byte for `-`. */
const DASH = 0x2d;

export class InboundScanStream extends Transform {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private headerDone = false;
  private breached = false;
  private delimiters = 0;
  private atStreamStart = true;
  /** Last ≤2 bytes of the previous chunk, so a `\n--` split across a chunk boundary is still counted. */
  private carry: Buffer = Buffer.alloc(0);
  /** The raw header block (without the trailing blank line), available once the stream ends. */
  block = '';

  constructor(private readonly limits: ScanLimits) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.breached) {
      this.countDelimiters(chunk);
      if (this.delimiters > this.limits.maxParts) {
        this.breach('too many MIME parts');
      } else if (!this.headerDone) {
        this.captureHeaders(chunk);
      }
    }
    cb(null, chunk);
  }

  private captureHeaders(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.captured += chunk.length;
    const joined = Buffer.concat(this.chunks);
    const boundary = headerBodyBoundary(joined);
    if (boundary >= 0) {
      this.block = joined.subarray(0, boundary).toString('utf8');
      this.headerDone = true;
      this.chunks.length = 0; // release the buffered prefix
    } else if (this.captured >= this.limits.maxHeaderBlockBytes) {
      this.breach('header block too large');
    }
  }

  /** Count lines beginning with `--` (boundary delimiters), handling chunk-boundary splits. */
  private countDelimiters(chunk: Buffer): void {
    const search = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    // A leading `--` at the very start of the stream is a delimiter too.
    if (this.atStreamStart && search.length >= 2 && search[0] === DASH && search[1] === DASH) {
      this.delimiters++;
    }
    let idx = search.indexOf('\n--');
    while (idx !== -1) {
      this.delimiters++;
      idx = search.indexOf('\n--', idx + 1);
    }
    this.atStreamStart = false;
    // Keep the last 2 bytes so a `\n--` straddling the next boundary is caught without double-counting.
    this.carry = search.subarray(Math.max(0, search.length - 2));
  }

  private breach(reason: string): void {
    if (this.breached) return;
    this.breached = true;
    this.chunks.length = 0;
    this.emit('breach', reason);
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
