/**
 * Reading verdicts from the RAW header lines of the message's root node. SES prepends
 * its `X-SES-*-Verdict` headers, so its verdict is the FIRST occurrence; an attacker
 * can inject their own lower down. Reading first-occurrence from the ordered raw lines
 * — with a duplicate treated as tampering — is the mitigation. The lines come from
 * mailsplit's structural parse of the root node (see parse.ts), which is where the
 * MIME structure/size/node-count limits are enforced too.
 */

/** One parsed header line: lowercased key + its unfolded value, in source order. */
export interface HeaderLine {
  readonly key: string;
  readonly value: string;
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
    if (line === '') {
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) {
      logical[logical.length - 1] += ' ' + line.trim();
    } else {
      logical.push(line);
    }
  }
  const out: HeaderLine[] = [];
  for (const line of logical) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
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

/**
 * The root header block of a raw message, from just its first bytes: everything before the
 * first blank line, or undefined when no blank line falls inside those bytes (the headers run
 * past what was read — treated as unreadable rather than parsed half-way). Kept as raw bytes:
 * the parser decodes 8-bit headers, so they must reach it untouched.
 */
export function rootHeaderBlock(prefix: Buffer): Buffer | undefined {
  const crlf = prefix.indexOf('\r\n\r\n');
  const lf = prefix.indexOf('\n\n');
  const candidates = [crlf, lf].filter((index) => index >= 0);
  if (candidates.length === 0) {
    return undefined;
  }
  return prefix.subarray(0, Math.min(...candidates));
}
