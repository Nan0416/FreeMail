/**
 * The two structural enforcers that sit in the MIME pipeline in front of MailParser
 * (which does the decoding). Both pass their input through UNCHANGED and emit
 * `'breach'` when a limit is exceeded; the parser orchestrator degrades to a bounded
 * quarantine on it.
 *
 * - {@link RawByteLimiter} bounds the total raw bytes streamed — defence in depth
 *   against a HEAD/GET race where the object grew after the pre-download size gate.
 * - {@link BodyLimiter} runs on mailsplit's structural node stream: it caps each
 *   text/HTML NODE's body bytes as they stream (before MailParser aggregates the full
 *   body), and exposes the root node's raw header block for verdict extraction. Real
 *   MIME-node counting + per-node header size are enforced by the mailsplit Splitter
 *   itself (its `maxChildNodes` / `maxHeadSize` options), which errors on breach — so
 *   this never counts `--`-prefixed body lines (e.g. a `-- ` signature) as boundaries.
 */
import { Transform, type TransformCallback } from 'node:stream';

/** A raw byte passthrough that breaches past `maxBytes`. */
export class RawByteLimiter extends Transform {
  private seen = 0;
  private breached = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.breached) {
      this.seen += chunk.length;
      if (this.seen > this.maxBytes) {
        this.breached = true;
        this.emit('breach', 'raw message exceeds size cap');
      }
    }
    cb(null, chunk);
  }
}

export interface BodyLimits {
  maxTextBodyBytes: number;
  maxHtmlBodyBytes: number;
  /** Cumulative text+HTML budget across ALL nodes — bounds MailParser's aggregate, not just one node. */
  maxTotalBodyBytes: number;
}

/** The mailsplit chunk shapes this limiter reads (structural subset). */
interface NodeChunk {
  type: 'node';
  root: boolean;
  multipart: string | false;
  contentType: string | false;
  /** Content-Disposition value (`attachment` / `inline`), or false when absent. */
  disposition: string | false;
  /** Decoded attachment filename, or false when absent. */
  filename: string | false;
  getHeaders(): Buffer;
}
interface ContentChunk {
  type: 'data' | 'body';
  value?: Buffer;
}
type MimeChunk = NodeChunk | ContentChunk;

/**
 * Object-mode passthrough over mailsplit's Splitter output. Caps each text/plain and
 * text/html leaf node's body bytes as its `body` chunks stream, AND the cumulative
 * text+HTML bytes across the whole message — so a breach fires (and the downstream
 * MailParser is torn down) BEFORE the full body is aggregated, bounding peak buffering
 * by the cap rather than the whole 40 MB message. The message-wide budget stops many
 * individually-under-cap text nodes from still aggregating past the bound. Attachment
 * (non-text) node bodies flow through untouched — they're capped separately as
 * MailParser streams them to the attachment sink.
 */
export class BodyLimiter extends Transform {
  private currentTextCap = 0; // 0 = current leaf is not a capped text node
  private currentBytes = 0;
  private totalTextBytes = 0; // cumulative across ALL text/html nodes
  private breached = false;
  /** The root node's raw header block, for first-occurrence verdict reading. */
  rootHeaderBlock = '';

  constructor(private readonly limits: BodyLimits) {
    super({ objectMode: true });
  }

  override _transform(chunk: MimeChunk, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.breached) {
      cb(null, chunk);
      return;
    }
    if (chunk.type === 'node') {
      if (chunk.root) {
        this.rootHeaderBlock = chunk.getHeaders().toString('utf8');
      }
      // Track only leaf text nodes; a multipart node or a non-text leaf resets the per-node cap.
      this.currentBytes = 0;
      this.currentTextCap = this.textCapFor(chunk);
    } else if (chunk.type === 'body' && this.currentTextCap > 0 && chunk.value) {
      this.currentBytes += chunk.value.length;
      this.totalTextBytes += chunk.value.length;
      if (this.currentBytes > this.currentTextCap) {
        this.breach('text/html body exceeds per-node size cap');
      } else if (this.totalTextBytes > this.limits.maxTotalBodyBytes) {
        this.breach('cumulative text/html body exceeds message budget');
      }
    }
    cb(null, chunk);
  }

  private breach(reason: string): void {
    this.breached = true;
    this.emit('breach', reason);
  }

  /**
   * The body cap for a leaf node by content type, or 0 when the node isn't a body node.
   * A text/* leaf that is an ATTACHMENT (Content-Disposition attachment, or carries a
   * filename) is NOT body — it's charged to the independent attachment caps as MailParser
   * streams it — so only INLINE text/plain and text/html count toward the body budget.
   */
  private textCapFor(node: NodeChunk): number {
    if (node.multipart !== false) return 0; // structural node, not a leaf
    if (node.disposition === 'attachment' || (node.filename && node.filename !== '')) return 0;
    const ct = (node.contentType || '').toLowerCase();
    if (ct === 'text/plain') return this.limits.maxTextBodyBytes;
    if (ct === 'text/html') return this.limits.maxHtmlBodyBytes;
    return 0; // attachment / other leaf → not capped here
  }
}
