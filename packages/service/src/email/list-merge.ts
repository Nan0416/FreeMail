/**
 * The unified `GET /emails` timeline: a k-way merge of the two partitions (`SENT`,
 * `INBOUND`) into one newest-first page, plus its opaque cursor. Pure w.r.t. an
 * injected `query` callback, so the merge + pagination are fully testable without DDB.
 *
 * The merge key is the sort key `sk = '<iso>#<id>'` compared as a whole string:
 * `sentAt`/`receivedAt` are both `Date.toISOString()` (UTC, millisecond precision), so
 * the ISO prefix orders across partitions, and the `#<id>` suffix makes the order total
 * (equal timestamps still break deterministically).
 *
 * The cursor records, per in-scope direction, the sk of the LAST row emitted from that
 * direction — nothing more. On resume each direction re-queries strictly after its own
 * `lastEmittedSk`, so a row that was fetched but lost the merge (the other partition
 * dominated the page) is simply re-fetched next page — never skipped, never duplicated.
 * The partition (`pk`) is derived server-side from the direction, so a crafted cursor can
 * carry only sk strings — it can never retarget the query at an arbitrary partition.
 */
import type { StoredEmailRow } from '../data/emails-repo.js';
import { emailErrors } from './errors.js';

type Direction = 'sent' | 'inbound';

/** Fetch one partition newest-first, at most `limit` rows strictly older than `afterSk`. */
export type MergeQuery = (
  direction: Direction,
  opts: { limit: number; afterSk?: string },
) => Promise<StoredEmailRow[]>;

export interface ListEmailsParams {
  query: MergeQuery;
  /** Restrict to one partition; omit for the merged timeline. */
  direction?: Direction;
  /** Page size — the caller clamps this to the allowed range. */
  limit: number;
  /** Opaque continuation token from a previous page. */
  cursor?: string;
}

export interface MergedPage {
  rows: StoredEmailRow[];
  /** Absent → the timeline is exhausted. */
  nextCursor?: string;
}

interface ListCursor {
  v: 1;
  sent?: string;
  inbound?: string;
}

/** Encode the per-direction continuation state into an opaque token. */
export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode + validate a cursor. A malformed token is a 400 (client error), not a 404. */
export function decodeListCursor(token: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw emailErrors.invalidRequest('Invalid cursor.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw emailErrors.invalidRequest('Invalid cursor.');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1) {
    throw emailErrors.invalidRequest('Invalid cursor.');
  }
  const cursor: ListCursor = { v: 1 };
  for (const dir of ['sent', 'inbound'] as const) {
    const value = raw[dir];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0) {
        throw emailErrors.invalidRequest('Invalid cursor.');
      }
      cursor[dir] = value;
    }
  }
  return cursor;
}

/** Descending sk order (newest first); total because sk carries the unique `#<id>` suffix. */
function bySkDescending(a: StoredEmailRow, b: StoredEmailRow): number {
  if (a.sk < b.sk) return 1;
  if (a.sk > b.sk) return -1;
  return 0;
}

/** Merge one page across the in-scope partitions and compute the continuation cursor. */
export async function listEmailsPage(params: ListEmailsParams): Promise<MergedPage> {
  const { query, limit } = params;
  const decoded = params.cursor ? decodeListCursor(params.cursor) : { v: 1 as const };
  const directions: Direction[] = params.direction ? [params.direction] : ['sent', 'inbound'];

  const fetched = {} as Record<Direction, StoredEmailRow[]>;
  for (const dir of directions) {
    fetched[dir] = await query(dir, { limit, afterSk: decoded[dir] });
  }

  const pool = directions.flatMap((dir) => fetched[dir]);
  pool.sort(bySkDescending);
  const rows = pool.slice(0, limit);

  const next: ListCursor = { v: 1 };
  let anyMore = false;
  for (const dir of directions) {
    const emitted = rows.filter((row) => row.direction === dir);
    // The page is sk-descending, so the LAST emitted row from a direction is its lowest sk.
    const lastEmittedSk = emitted.length > 0 ? emitted[emitted.length - 1].sk : decoded[dir];
    // ALWAYS carry this direction's continuation position — even if it drained this page.
    // Omitting it would make the next page restart the direction from the newest row
    // (re-emitting everything → dupes / non-termination). A drained direction simply
    // re-queries strictly after this sk next page and returns nothing. Undefined only when
    // it emitted nothing AND had no prior cursor (fully dominated on page 1) — then it
    // re-competes from the top next page, which re-fetches (never skips).
    if (lastEmittedSk !== undefined) {
      next[dir] = lastEmittedSk;
    }
    // More remains if we hit the fetch limit, or some fetched rows lost the merge this page.
    if (fetched[dir].length === limit || fetched[dir].length > emitted.length) {
      anyMore = true;
    }
  }

  return { rows, ...(anyMore ? { nextCursor: encodeListCursor(next) } : {}) };
}
