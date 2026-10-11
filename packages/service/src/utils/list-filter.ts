/**
 * Search filters for the mailbox list: text matched against the envelope the list index
 * carries, plus a date range. Shared by REST `GET /emails` and the `list_emails` MCP tool
 * through {@link parseListEmailsQuery}.
 *
 * The date range is a key condition — the sort key is `<iso>#<id>`, so "on or after A, before
 * B" is `A <= sk <= B` on the fixed-width ISO strings, answered by DynamoDB. The text filters
 * are not: DynamoDB can only match case-sensitively, and FreeMail is one mailbox, so the read
 * service reads list-index rows newest-first and matches them here, case-insensitively, under
 * a per-page scan budget (see the read service).
 */
import type { EmailListFilters } from '@freemail/shared';
import type { EmailSummary } from '../data/emails-dao.js';

/** True when any text filter is set — the list must then scan rather than read one page. */
export function hasTextFilters(filters: EmailListFilters | undefined): boolean {
  return (
    filters !== undefined &&
    (filters.query !== undefined ||
      filters.from !== undefined ||
      filters.to !== undefined ||
      filters.subject !== undefined)
  );
}

/** Does `row` satisfy every text filter? Each is a case-insensitive substring match. */
export function matchesListFilters(row: EmailSummary, filters: EmailListFilters): boolean {
  const sender = [row.from, row.direction === 'inbound' ? row.fromName : undefined];
  const recipients = [...row.to, ...row.cc];
  const snippet = row.direction === 'inbound' ? row.snippet : undefined;
  return (
    contains([row.subject], filters.subject) &&
    contains(sender, filters.from) &&
    contains(recipients, filters.to) &&
    contains([...sender, ...recipients, row.subject, snippet], filters.query)
  );
}

/** The inclusive sort-key bounds for a date range: `after` (inclusive) and `before` (exclusive). */
export function sortKeyBounds(filters: EmailListFilters | undefined): {
  readonly minSk?: string;
  readonly maxSk?: string;
} {
  // sk = '<iso>#<id>' sorts after its own '<iso>', so `sk >= after` keeps rows AT `after`, and
  // `sk <= before` drops rows at `before` — exactly [after, before).
  return {
    ...(filters?.after !== undefined ? { minSk: filters.after } : {}),
    ...(filters?.before !== undefined ? { maxSk: filters.before } : {}),
  };
}

function contains(fields: ReadonlyArray<string | undefined>, needle: string | undefined): boolean {
  if (needle === undefined) {
    return true;
  }
  const wanted = needle.toLowerCase();
  return fields.some((field) => field !== undefined && field.toLowerCase().includes(wanted));
}
