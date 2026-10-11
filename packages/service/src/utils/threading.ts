/**
 * Reply threading: the RFC 5322 `Message-ID` / `In-Reply-To` / `References` headers that make
 * a reply land in the same conversation in the recipient's mail client.
 *
 * The values come from two places. A received message's own `Message-ID` and `References` are
 * read at ingest — attacker-controlled, so they are kept only when each id is a well-formed
 * `<…>` token of printable ASCII (no whitespace, no CR/LF, no angle brackets inside) and they
 * are capped in length and count before they can ever reach an outgoing header. A message we
 * sent has no stored `Message-ID` of ours: SES replaces whatever the composer wrote with
 * `<sesMessageId@email.amazonses.com>` (`<id@<region>.amazonses.com>` outside us-east-1), which
 * is what recipients — and their replies' `In-Reply-To` — see, so it is derived from the SES
 * message id.
 */

/** One `msg-id`: `<`, 1–250 printable ASCII characters other than `<` and `>`, `>`. */
const MESSAGE_ID_RE = /^<[!-;=?-~]{1,250}>$/;

/**
 * Max ids kept in a `References` chain. A long thread keeps its first id (the root) and the
 * most recent ones, as RFC 5322 §3.6.4 suggests when trimming.
 */
export const MAX_REFERENCES = 20;

/** The id when `value` is one well-formed `msg-id`, else undefined. */
export function sanitizeMessageId(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  return MESSAGE_ID_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * The well-formed ids of a `References` header — as mailparser gives it (a string or a list of
 * strings, each possibly holding several ids) — in order, de-duplicated, trimmed to
 * {@link MAX_REFERENCES}. Malformed tokens are dropped, not repaired.
 */
export function sanitizeReferences(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      continue;
    }
    for (const token of part.split(/\s+/)) {
      const id = sanitizeMessageId(token);
      if (id !== undefined && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return trimReferences(ids);
}

/** The `References` for a reply: the parent's chain, then the parent's own id — trimmed. */
export function replyReferences(
  parentReferences: readonly string[] | undefined,
  parentMessageId: string,
): string[] {
  const chain = (parentReferences ?? []).filter((id) => id !== parentMessageId);
  return trimReferences([...chain, parentMessageId]);
}

/** Keep the root and the newest ids when a chain is longer than {@link MAX_REFERENCES}. */
function trimReferences(ids: readonly string[]): string[] {
  if (ids.length <= MAX_REFERENCES) {
    return [...ids];
  }
  return [ids[0], ...ids.slice(ids.length - (MAX_REFERENCES - 1))];
}

/**
 * The `Message-ID` SES gives a message it sends: `<sesMessageId@email.amazonses.com>` in
 * us-east-1, `<sesMessageId@<region>.amazonses.com>` elsewhere.
 */
export function sesMessageIdHeader(sesMessageId: string, region: string): string {
  const host = region === 'us-east-1' ? 'email.amazonses.com' : `${region}.amazonses.com`;
  return `<${sesMessageId}@${host}>`;
}

/** `Re: <subject>`, unless the subject already starts with `Re:` (any case). */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`.trimEnd();
}
