/**
 * Turns a received message's raw MIME into the copy the forwarder sends ("rewrite and resend").
 *
 * SES sends only `From:` a verified identity, so the copy cannot claim the original sender.
 * Instead it is From this deployment's forwarding address, with the original sender in the
 * display name ("Alice (alice@x.com) via example.com") and in `Reply-To`, so a reply still goes
 * to them. SES then signs the copy with this domain's DKIM key, and SPF/DKIM/DMARC all pass as
 * this domain.
 *
 * Everything after the header block — every body part and attachment — is copied byte for byte.
 * Of the headers, only these change:
 * - dropped: `From`, `Sender`, `Return-Path`, `Message-ID` (SES writes its own), `DKIM-Signature`
 *   (no longer valid once `From` changes; SES signs the copy itself), and the headers SES added on
 *   receipt — `Authentication-Results`, `Received-SPF`,
 *   `X-SES-*` — which describe this hop, not the copy, and would read as tampering to another
 *   receiver that trusts the first one it sees;
 * - added: the new `From`, `Reply-To` (only when the message had none), and
 *   {@link FORWARDED_MARKER_HEADER}, which stops a copy that comes back here being forwarded again.
 *
 * A copy whose sender SES could not verify (only a rule that skips DMARC forwards one) says so:
 * "(unverified)" in the From display name and {@link SENDER_UNVERIFIED_HEADER}. Signed by this
 * domain, it would otherwise pass for authenticated mail from whoever the From claimed.
 */
import { encodeWord } from 'nodemailer/lib/mime-funcs/index.js';

/** Marks a forwarded copy. A received message carrying it is never forwarded (loop guard). */
export const FORWARDED_MARKER_HEADER = 'X-FreeMail-Forwarded';
/** Added, with the value `no`, to a copy whose original sender failed (or had no) DMARC. */
export const SENDER_UNVERIFIED_HEADER = 'X-FreeMail-Sender-Verified';

// The sender-verified header too: only this code may say whether the sender was verified.
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'sender',
  'return-path',
  'message-id',
  'dkim-signature',
  'authentication-results',
  'received-spf',
  SENDER_UNVERIFIED_HEADER.toLowerCase(),
]);

const DROPPED_PREFIX = 'x-ses-';

/** A bare address safe to write into a header as is: an ASCII dot-atom local part and a host. */
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

export interface BuildForwardedMimeInput {
  /** The received message, exactly as SES stored it. */
  readonly raw: Buffer;
  /** The copy's From address — on this deployment's own (verified) domain. */
  readonly forwarderAddress: string;
  /** Shown after "via" in the copy's From display name. */
  readonly forwarderLabel: string;
  /** The original sender's address, as the row recorded it. */
  readonly from: string;
  /** The original sender's display name, as the row recorded it. */
  readonly fromName?: string | undefined;
  /** The received message's id, recorded in the marker header. */
  readonly messageId: string;
  /** Whether SES's DMARC check passed for the original sender's domain. */
  readonly senderVerified: boolean;
}

/** The forwarded copy, or undefined when the message has no header block to rewrite. */
export function buildForwardedMime(input: BuildForwardedMimeInput): Buffer | undefined {
  const end = headerBlockEnd(input.raw);
  if (end === undefined) {
    return undefined;
  }
  // latin1 maps each byte to one char and back, so 8-bit header bytes survive untouched.
  const headerText = input.raw.subarray(0, end).toString('latin1');
  const eol = headerText.includes('\r\n') ? '\r\n' : '\n';
  const fields = splitHeaderFields(headerText);
  const from = input.from.trim();
  const plainFrom = PLAIN_ADDRESS.test(from);
  const name = input.fromName?.trim();
  const sender = name ? (plainFrom ? `${name} (${from})` : name) : from;

  const label = input.senderVerified ? `${sender} via ${input.forwarderLabel}` : `${sender} (unverified) via ${input.forwarderLabel}`;
  const added = [`${FORWARDED_MARKER_HEADER}: ${input.messageId}`, `From: ${displayName(label, eol)} <${input.forwarderAddress}>`];
  if (!input.senderVerified) {
    added.push(`${SENDER_UNVERIFIED_HEADER}: no`);
  }
  if (plainFrom && !fields.some((field) => field.name === 'reply-to')) {
    added.push(`Reply-To: ${name ? `${displayName(name, eol)} <${from}>` : from}`);
  }
  const kept = fields.filter((field) => !isDropped(field.name)).map((field) => field.lines.join(eol));
  const head = Buffer.from([...added, ...kept].join(eol), 'latin1');
  // The rest starts with the line break ending the last header, then the blank line.
  return Buffer.concat([head, input.raw.subarray(end)]);
}

interface HeaderField {
  /** Lowercased name; `''` for a malformed line, which is kept as is. */
  readonly name: string;
  /** The field's physical lines: the first, then any folded continuations. */
  readonly lines: string[];
}

/** Where the header block ends: the index of the line break before the first blank line. */
function headerBlockEnd(raw: Buffer): number | undefined {
  const candidates = [raw.indexOf('\r\n\r\n'), raw.indexOf('\n\n')].filter((index) => index >= 0);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

function splitHeaderFields(text: string): HeaderField[] {
  const fields: HeaderField[] = [];
  // A bare CR ends a line too, as the inbound header parser reads it: a header smuggled after one
  // is then its own field here as well (and dropped if it is one of the dropped kinds).
  for (const line of text.split(/\r\n|\n|\r/)) {
    const last = fields[fields.length - 1];
    if ((line.startsWith(' ') || line.startsWith('\t')) && last !== undefined) {
      last.lines.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    fields.push({
      name: colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '',
      lines: [line],
    });
  }
  return fields;
}

function isDropped(name: string): boolean {
  return DROPPED_HEADERS.has(name) || name.startsWith(DROPPED_PREFIX);
}

/**
 * A display name as a header phrase: a quoted string when it is printable ASCII, otherwise
 * RFC 2047 encoded words, folded onto continuation lines so no line runs long.
 */
function displayName(value: string, eol: string): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return `"${clean.replace(/(["\\])/g, '\\$1')}"`;
  }
  return encodeWord(clean, 'B', 52).split(' ').join(`${eol} `);
}
