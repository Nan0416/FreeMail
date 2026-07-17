/**
 * Streaming MIME parse — the untrusted-content core. Uses mailparser's streaming
 * `MailParser` (NOT `simpleParser`, which buffers the whole message + every decoded
 * attachment at once) so only one attachment is held in memory at a time and a
 * hostile message can be aborted mid-stream on the first limit breach. Auto
 * HTML↔text generation is disabled; the snippet is derived separately and bounded.
 *
 * Verdicts are read from the RAW captured header block (first occurrence), not the
 * body parser — see `headers.ts`/`verdicts.ts`. Attachments are extracted (and the
 * body kept for the snippet) ONLY when the virus verdict is an affirmative `PASS`;
 * otherwise each attachment is drained + released without being stored and no body
 * is retained. Every limit is enforced regardless, so a quarantined message can't
 * DoS the parser either.
 *
 * HANDLED failures (malformed MIME → `parse_failed`, a limit breach →
 * `limit_exceeded`) still RESOLVE, carrying whatever header metadata was captured, so
 * the caller can write a bounded quarantine row that identifies the message. Only a
 * real infra failure (the attachment sink / the S3 source stream) rejects, so the
 * async invocation retries.
 */
import type { Readable } from 'node:stream';
import { MailParser, type AddressObject } from 'mailparser';
import type { InboundAttachmentDescriptor, InboundParseStatus } from '../data/emails-repo.js';
import { InboundLimitError } from './errors.js';
import { InboundScanStream, parseHeaderLines, type HeaderLine } from './headers.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HTML_BODY_BYTES,
  MAX_MIME_PARTS,
  MAX_TEXT_BODY_BYTES,
} from './limits.js';
import { normalizeAddressList, normalizeFrom, sanitizeSubject } from './sanitize.js';
import { extractVerdicts, type Verdicts } from './verdicts.js';

/**
 * Sink for extracted attachments. `store` writes one attachment (called only when the
 * message is exposable) and returns its descriptor. The processor owns the sink and
 * tracks written keys, so it can clean them up if parsing then fails.
 */
export interface AttachmentSink {
  store(
    partIndex: number,
    filename: string | undefined,
    contentType: string,
    bytes: Buffer,
  ): Promise<InboundAttachmentDescriptor>;
}

export interface ParsedInbound {
  parseStatus: InboundParseStatus;
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The `Date:` header as ISO, if present and parseable. Display-only, attacker-controlled. */
  headerDate?: string;
  verdicts: Verdicts;
  /** Whether attachments were extracted / body retained (parse ok AND virus `PASS`). */
  exposed: boolean;
  /** Plain-text body, retained only when exposed — for the snippet. */
  textBody?: string;
  /** HTML body, retained only when exposed — for the snippet. */
  htmlBody?: string;
  /** Attachments actually seen (whether or not stored). */
  attachmentCount: number;
  /** Stored descriptors — non-empty only when exposed and parsing succeeded. */
  attachments: InboundAttachmentDescriptor[];
}

/** The streaming attachment node's shape (the parts of mailparser's AttachmentStream we use). */
interface AttachmentNode {
  type: 'attachment';
  content: Readable;
  filename?: string;
  contentType: string;
  release(): void;
}

/** Resource limits for one parse — defaults to the module constants; overridable in tests. */
export interface ParseLimits {
  maxParts: number;
  maxHeaderBlockBytes: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxAttachmentTotalBytes: number;
  maxTextBodyBytes: number;
  maxHtmlBodyBytes: number;
}

const DEFAULT_LIMITS: ParseLimits = {
  maxParts: MAX_MIME_PARTS,
  maxHeaderBlockBytes: MAX_HEADER_BLOCK_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxAttachmentTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
  maxTextBodyBytes: MAX_TEXT_BODY_BYTES,
  maxHtmlBodyBytes: MAX_HTML_BODY_BYTES,
};

/**
 * Parse a raw MIME stream. Resolves for both success and handled (attacker-controlled)
 * failures — the `parseStatus` distinguishes them. Rejects only for a real infra
 * failure from the sink or the source stream, so those retry.
 */
export function parseInbound(
  source: Readable,
  sink: AttachmentSink,
  limits: ParseLimits = DEFAULT_LIMITS,
): Promise<ParsedInbound> {
  return new Promise<ParsedInbound>((resolve, reject) => {
    const scan = new InboundScanStream({
      maxParts: limits.maxParts,
      maxHeaderBlockBytes: limits.maxHeaderBlockBytes,
    });
    const parser = new MailParser({
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      // Bound MailParser's own HTML processing, not just our retained snippet input.
      maxHtmlLengthToParse: limits.maxHtmlBodyBytes,
    });

    let outcome: 'pending' | 'settled' = 'pending';
    let parseStatus: InboundParseStatus = 'ok';
    let ended = false;
    let pending = 0;

    let verdicts: Verdicts | undefined;
    let exposed = false;

    let from = '';
    let fromName: string | undefined;
    let to: string[] = [];
    let cc: string[] = [];
    let subject = '';
    let headerDate: string | undefined;
    let textBody: string | undefined;
    let htmlBody: string | undefined;
    const attachments: InboundAttachmentDescriptor[] = [];

    const ensureVerdicts = (): void => {
      if (verdicts) return;
      const lines: HeaderLine[] = parseHeaderLines(scan.block);
      verdicts = extractVerdicts(lines);
      exposed = verdicts.virusVerdict === 'PASS';
    };

    const teardown = (): void => {
      source.destroy();
      scan.destroy();
      parser.destroy();
    };

    /** Resolve with the captured metadata (the current `parseStatus`). */
    const settleResolve = (): void => {
      if (outcome === 'settled') return;
      outcome = 'settled';
      ensureVerdicts();
      resolve({
        parseStatus,
        from,
        fromName,
        to,
        cc,
        subject,
        headerDate,
        verdicts: verdicts!,
        exposed: exposed && parseStatus === 'ok',
        textBody: exposed && parseStatus === 'ok' ? textBody : undefined,
        htmlBody: exposed && parseStatus === 'ok' ? htmlBody : undefined,
        attachmentCount,
        attachments: parseStatus === 'ok' ? attachments : [],
      });
    };

    /** A handled (attacker) failure: mark status, stop, resolve-quarantine. */
    const degrade = (status: Exclude<InboundParseStatus, 'ok'>): void => {
      if (outcome === 'settled') return;
      if (parseStatus === 'ok') parseStatus = status;
      teardown();
      settleResolve();
    };

    /** A real infra failure: reject so the async invocation retries. */
    const failInfra = (err: unknown): void => {
      if (outcome === 'settled') return;
      outcome = 'settled';
      teardown();
      reject(err);
    };

    let attachmentCount = 0;
    let totalBytes = 0;

    parser.on('headers', (headers) => {
      ensureVerdicts();
      const fromObj = headers.get('from') as AddressObject | undefined;
      ({ from, fromName } = normalizeFrom(fromObj));
      to = normalizeAddressList(headers.get('to') as AddressObject | AddressObject[] | undefined);
      cc = normalizeAddressList(headers.get('cc') as AddressObject | AddressObject[] | undefined);
      const rawSubject = headers.get('subject');
      subject = sanitizeSubject(typeof rawSubject === 'string' ? rawSubject : undefined);
      const date = headers.get('date');
      headerDate =
        date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
    });

    // The scan stream counts MIME parts structurally over the raw bytes and enforces
    // the header-block size — neither is visible from MailParser's aggregated events.
    scan.on('breach', () => degrade('limit_exceeded'));

    parser.on('data', (data) => {
      if (outcome === 'settled') {
        if (data.type === 'attachment') safeRelease(data);
        return;
      }
      if (data.type === 'attachment') {
        attachmentCount++;
        if (attachmentCount > limits.maxAttachments) {
          safeRelease(data);
          return degrade('limit_exceeded');
        }
        ensureVerdicts();
        pending++;
        void handleAttachment(data as AttachmentNode, attachmentCount - 1);
      } else {
        // A body larger than the cap is a resource-exhaustion attempt → quarantine.
        if (
          (typeof data.text === 'string' && data.text.length > limits.maxTextBodyBytes) ||
          (typeof data.html === 'string' && data.html.length > limits.maxHtmlBodyBytes)
        ) {
          return degrade('limit_exceeded');
        }
        if (typeof data.text === 'string') textBody = data.text;
        if (typeof data.html === 'string') htmlBody = data.html;
      }
    });

    // A parse error is content (attacker-controlled), not infra.
    parser.on('error', () => degrade('parse_failed'));
    parser.on('end', () => {
      ended = true;
      maybeFinish();
    });
    // The S3 source / passthrough erroring mid-download is infra → retry.
    source.on('error', (err) => failInfra(err instanceof Error ? err : new Error(String(err))));
    scan.on('error', (err) => failInfra(err instanceof Error ? err : new Error(String(err))));

    function maybeFinish(): void {
      if (outcome === 'settled' || !ended || pending > 0) return;
      settleResolve();
    }

    async function handleAttachment(data: AttachmentNode, partIndex: number): Promise<void> {
      let bytes: Buffer;
      try {
        bytes = await readCapped(data.content, limits.maxAttachmentBytes);
      } catch (err) {
        safeRelease(data);
        pending--;
        // readCapped throws InboundLimitError past the cap; any other stream error is a
        // malformed/decoded-part failure → parse_failed. Both are handled (no retry).
        if (err instanceof InboundLimitError) degrade('limit_exceeded');
        else degrade('parse_failed');
        return;
      }
      totalBytes += bytes.length;
      if (totalBytes > limits.maxAttachmentTotalBytes) {
        safeRelease(data);
        pending--;
        return degrade('limit_exceeded');
      }
      if (exposed) {
        try {
          attachments.push(await sink.store(partIndex, data.filename, data.contentType, bytes));
        } catch (err) {
          // A sink (S3) failure is infra → propagate for retry.
          safeRelease(data);
          pending--;
          return failInfra(err);
        }
      }
      safeRelease(data);
      pending--;
      maybeFinish();
    }

    source.pipe(scan).pipe(parser);
  });
}

function safeRelease(data: { release?: () => void }): void {
  try {
    data.release?.();
  } catch {
    // releasing a torn-down stream can throw; ignore
  }
}

/** Read a stream into a Buffer, aborting with an InboundLimitError past `cap` bytes. */
function readCapped(stream: Readable, cap: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        stream.destroy();
        reject(new InboundLimitError('attachment exceeds per-file size limit'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}
