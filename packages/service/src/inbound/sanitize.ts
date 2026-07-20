/**
 * Turning attacker-controlled MIME fields into bounded, safe plain text before they
 * are stored (and later displayed). Everything here strips control characters and
 * CRLF (header/snippet injection), collapses whitespace, and caps length. HTML is
 * reduced to text with a real bounded parser — never regex — and only after the
 * input itself is length-capped so the parser work is bounded too.
 */
import { convert as htmlToText } from 'html-to-text';
import type { AddressObject, EmailAddress } from 'mailparser';
import {
  MAX_ADDRESS_CHARS,
  MAX_ADDRESSES_PER_HEADER,
  MAX_FILENAME_CHARS,
  MAX_HTML_SNIPPET_INPUT_BYTES,
  MAX_SNIPPET_CHARS,
  MAX_SUBJECT_CHARS,
} from './limits.js';

/** Control chars (incl. CR/LF/TAB) + DEL + Unicode line/para separators, replaced with a space. */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_LINE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;
const WHITESPACE_RUN = /\s+/g;

/** Collapse a header/text value to a single line of safe, whitespace-normalized text, capped. */
export function sanitizeText(value: string | undefined, maxChars: number): string {
  if (!value) {
    return '';
  }
  const cleaned = value.replace(CONTROL_AND_LINE, ' ').replace(WHITESPACE_RUN, ' ').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

/** Subject → single-line safe text, capped. */
export function sanitizeSubject(value: string | undefined): string {
  return sanitizeText(value, MAX_SUBJECT_CHARS);
}

/**
 * A display-only filename: control chars/CRLF stripped, path separators neutralized,
 * capped. Never used in the (opaque) S3 key — this is metadata for the reader's
 * download `Content-Disposition` only. Empty/degenerate names fall back to `attachment`.
 */
export function sanitizeFilename(value: string | undefined): string {
  const noSep = (value ?? '').replace(/[/\\]/g, '_');
  const cleaned = sanitizeText(noSep, MAX_FILENAME_CHARS);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** One address string, sanitized + capped. */
function sanitizeAddress(addr: string | undefined): string {
  return sanitizeText(addr, MAX_ADDRESS_CHARS);
}

/** A content-type kept for display/metadata only — sanitized, capped, safe default. */
export function sanitizeContentType(value: string | undefined): string {
  const cleaned = sanitizeText(value, 128);
  return cleaned.length > 0 ? cleaned : 'application/octet-stream';
}

/** Flatten mailparser address object(s) to a bounded list of sanitized address strings. */
export function normalizeAddressList(input: AddressObject | AddressObject[] | undefined): string[] {
  if (!input) {
    return [];
  }
  const objects = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const obj of objects) {
    for (const entry of flattenAddresses(obj.value)) {
      if (out.length >= MAX_ADDRESSES_PER_HEADER) {
        return out;
      }
      const addr = sanitizeAddress(entry.address);
      if (addr) {
        out.push(addr);
      }
    }
  }
  return out;
}

/** Group addresses nest via `.group`; flatten to leaf addresses. */
function flattenAddresses(entries: EmailAddress[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const e of entries) {
    if (e.group && e.group.length > 0) {
      out.push(...flattenAddresses(e.group));
    } else {
      out.push(e);
    }
  }
  return out;
}

/** The single `From` for the record: its first address + optional display name, sanitized. */
export function normalizeFrom(input: AddressObject | undefined): {
  from: string;
  fromName?: string;
} {
  const first = input ? flattenAddresses(input.value)[0] : undefined;
  const from = sanitizeAddress(first?.address);
  const fromName = sanitizeText(first?.name, MAX_ADDRESS_CHARS);
  return fromName ? { from, fromName } : { from };
}

/** A snippet from a plain-text body — sanitized + capped. */
export function snippetFromText(text: string | undefined): string {
  return sanitizeText(text, MAX_SNIPPET_CHARS);
}

/**
 * A snippet from an HTML body. The HTML input is length-capped FIRST (bounds the
 * parser's own work), reduced to text by html-to-text (links/images dropped, no
 * wrapping), then sanitized + capped like any other text.
 */
export function snippetFromHtml(html: string | undefined): string {
  if (!html) {
    return '';
  }
  const bounded =
    html.length > MAX_HTML_SNIPPET_INPUT_BYTES ? html.slice(0, MAX_HTML_SNIPPET_INPUT_BYTES) : html;
  const text = htmlToText(bounded, {
    wordwrap: false,
    limits: { maxInputLength: MAX_HTML_SNIPPET_INPUT_BYTES },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  });
  return sanitizeText(text, MAX_SNIPPET_CHARS);
}
