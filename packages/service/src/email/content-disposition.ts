/**
 * Builds a safe `Content-Disposition` header value for an attachment download. The
 * filename is attacker-controlled (it comes from inbound MIME), and it flows into the
 * presigned URL's `response-content-disposition` param → an S3 response header — a
 * header-injection sink. So we:
 *
 *   1. force `attachment` (never `inline`) — the browser downloads, never renders;
 *   2. strip every control char (incl. CR/LF/TAB/DEL and Unicode line separators) so
 *      nothing can break out of the header or inject a new one;
 *   3. emit BOTH a quoted ASCII `filename=` fallback (no `"`/`\` to close the quote
 *      early) and an RFC 5987/6266 `filename*=UTF-8''…` with the full percent-encoded
 *      name for modern clients.
 *
 * A degenerate/empty name falls back to `download`.
 */

/** Control chars (incl. CR/LF/TAB) + DEL + Unicode line/para separators — stripped entirely. */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_LINE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

/**
 * A lone (unpaired) UTF-16 surrogate — a high surrogate not followed by a low, or a low
 * not preceded by a high. Removed before encoding: `encodeURIComponent` throws `URIError`
 * on a lone surrogate, which would otherwise 500 the download for a hostile filename.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Max chars (CODE POINTS) we keep from a (display-only) filename in the header. */
const MAX_HEADER_FILENAME_CHARS = 255;

/** Percent-encode a UTF-8 string down to the RFC 5987 `attr-char` set. */
function encodeRfc5987(value: string): string {
  // encodeURIComponent leaves ! ' ( ) * ~ and alphanumerics; of those, ' ( ) * are NOT
  // RFC 5987 attr-chars, so percent-encode them too. (Encoding a char that IS allowed is
  // still valid, so we don't need to un-encode the rest.)
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * The `Content-Disposition` value for downloading `filename`. Always `attachment`; the
 * name is sanitized for the ASCII fallback and RFC-5987-encoded for `filename*`.
 */
export function contentDispositionForDownload(filename: string | undefined): string {
  const cleaned = (filename ?? '').replace(CONTROL_AND_LINE, '').replace(LONE_SURROGATE, '');
  // Slice by CODE POINTS (not UTF-16 code units) so the 255-char cap never splits a
  // surrogate pair (an emoji) into a lone surrogate that would throw on encode.
  const stripped = Array.from(cleaned).slice(0, MAX_HEADER_FILENAME_CHARS).join('');

  // ASCII fallback: printable ASCII only, minus the quote/backslash that would close the
  // quoted-string early. Anything else becomes '_'. Empty → 'download'.
  const asciiFallback =
    stripped
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'download';

  const encoded = encodeRfc5987(stripped);
  const base = `attachment; filename="${asciiFallback}"`;
  // Only add filename* when it carries something (non-empty after stripping).
  return encoded.length > 0 ? `${base}; filename*=UTF-8''${encoded}` : base;
}
