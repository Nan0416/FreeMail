/**
 * Bounds a materialized message body so one email can't blow the Lambda / API Gateway
 * ~6 MB response limit. The parser retains a body by CHARACTER count, but the JSON
 * response is measured in UTF-8 BYTES — and JSON escaping inflates a hostile body
 * (control chars escape to `\uXXXX` = 6×, quotes/backslashes = 2×). So two layers:
 *
 *   1. cap each part to a raw UTF-8 byte budget (truncated on a char boundary);
 *   2. shrink until the JSON-escaped `{text, html}` total fits a hard byte budget — a
 *      pathological (e.g. control-char-dense) body is halved until it fits.
 *
 * Normal bodies pass untouched; anything truncated is flagged so the client can offer the
 * raw message. The raw message is always retained in S3 regardless.
 */

/** Truncate a string to at most `maxBytes` UTF-8 bytes, cutting on a character boundary. */
export function truncateToUtf8Bytes(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) {
    return { value, truncated: false };
  }
  let cut = Math.max(0, maxBytes);
  // Back off over a split multi-byte sequence — UTF-8 continuation bytes are 10xxxxxx.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut--;
  }
  return { value: buf.toString('utf8', 0, cut), truncated: true };
}

export interface FittedBody {
  text?: string;
  html?: string;
  truncated: boolean;
}

function utf8Len(value: string | undefined): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0;
}

/** Cap each part to `partCapBytes` raw, then shrink until the JSON-escaped total ≤ budget. */
export function fitBodyToBudget(
  rawText: string | undefined,
  rawHtml: string | undefined,
  opts: { partCapBytes: number; serializedBudgetBytes: number },
): FittedBody {
  let truncated = false;
  let text = rawText;
  let html = rawHtml;

  if (text !== undefined) {
    const capped = truncateToUtf8Bytes(text, opts.partCapBytes);
    text = capped.value;
    truncated = truncated || capped.truncated;
  }
  if (html !== undefined) {
    const capped = truncateToUtf8Bytes(html, opts.partCapBytes);
    html = capped.value;
    truncated = truncated || capped.truncated;
  }

  const serializedBytes = (): number => Buffer.byteLength(JSON.stringify({ text, html }), 'utf8');

  // Halve the larger part until the escaped total fits (halving converges; bounded loop).
  while (serializedBytes() > opts.serializedBudgetBytes && utf8Len(text) + utf8Len(html) > 0) {
    const textBytes = utf8Len(text);
    const htmlBytes = utf8Len(html);
    if (htmlBytes >= textBytes && html !== undefined) {
      html = truncateToUtf8Bytes(html, Math.floor(htmlBytes / 2)).value;
    } else if (text !== undefined) {
      text = truncateToUtf8Bytes(text, Math.floor(textBytes / 2)).value;
    } else {
      break;
    }
    truncated = true;
  }

  const result: FittedBody = { truncated };
  if (text !== undefined) {
    result.text = text;
  }
  if (html !== undefined) {
    result.html = html;
  }
  return result;
}
