/**
 * Reply threading: the RFC 5322 `Message-ID` / `In-Reply-To` / `References` headers that make
 * a reply land in the same conversation in the recipient's mail client.
 *
 * The values come from two places. A received message's own `Message-ID` and `References` are
 * read at ingest — attacker-controlled, so an id is kept only when it has RFC 5322's `msg-id`
 * shape, `<id-left@id-right>` built from atext and dots (no whitespace, no CR/LF, no quotes,
 * parentheses, or angle brackets), and the chain is capped in length and count before it can
 * ever reach an outgoing header. For a message we sent, SES replaces whatever the composer
 * wrote with `<sesMessageId@email.amazonses.com>` (`<id@<region>.amazonses.com>` outside
 * us-east-1) — what recipients, and their replies' `In-Reply-To`, see. The send records that id
 * when SES accepts the message; for an older row it is derived from the SES message id.
 */

/** RFC 5322 `atext`, plus `.` (dot-atom). */
const ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~.]";

/**
 * One `msg-id`: `<id-left@id-right>`, each side dot-atom text (id-right may also be a `[…]`
 * literal), at most 250 characters between the brackets.
 */
const MESSAGE_ID_RE = new RegExp(`^<(?=.{3,250}>$)${ATOM}+@(?:${ATOM}+|\\[${ATOM}+\\])>$`);

/**
 * Max ids kept in a `References` chain. A long thread keeps its first id (the root) and the
 * most recent ones, as RFC 5322 §3.6.4 suggests when trimming.
 */
export const MAX_REFERENCES = 20;

/** The id when `value` is one well-formed `msg-id`, else undefined. */
export function sanitizeMessageId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return MESSAGE_ID_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * The well-formed ids of a `References` header — as mailparser gives it (a string or a list of
 * strings, each possibly holding several ids) — in order, de-duplicated, trimmed to
 * {@link MAX_REFERENCES}. mailparser has already split the header on whitespace and wrapped
 * each token in `<>`, so a token without the `id-left@id-right` shape (a comment, a stray
 * word) is dropped here. Linear in the header's size, which the parser caps.
 */
export function sanitizeReferences(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      continue;
    }
    for (const token of part.split(/\s+/)) {
      const id = sanitizeMessageId(token);
      if (id !== undefined && !seen.has(id)) {
        seen.add(id);
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
