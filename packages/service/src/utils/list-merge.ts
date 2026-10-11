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
 *
 * Filtered listings (#search) add one wrinkle: a partition's query may stop short — it examined
 * its scan budget without filling the page — while unexamined rows remain below its frontier.
 * Those rows may be newer than another partition's matches, so a page emits only rows at or
 * above the lowest point EVERY unfinished partition has examined (the highest frontier), and a
 * partition that matched nothing resumes from its frontier, so each page makes progress. For an
 * unfiltered query (a full page, or the end of the partition) the cut never removes anything:
 * the page's top `limit` rows all sit above every full partition's last row.
 */
import type { EmailListFilter } from '@freemail/shared';
import type { EmailSummary } from '../data/emails-dao.js';
import { emailErrors } from './errors.js';

/** A listable partition: `sent`, `inbound`, or `failed` (the Errors folder). */
type Direction = EmailListFilter;

/** One partition's contribution to a page. */
export interface MergeQueryResult {
  /** Matching rows, newest-first, at most `limit`, all strictly older than `afterSk`. */
  readonly rows: readonly EmailSummary[];
  /** True when the partition has nothing older than what was examined. */
  readonly exhausted: boolean;
  /** The oldest sort key examined, matching or not: every row above it has been seen. */
  readonly scannedToSk?: string;
}

/** Fetch one partition newest-first, strictly older than `afterSk`. */
export type MergeQuery = (
  direction: Direction,
  opts: { readonly limit: number; readonly afterSk?: string },
) => Promise<MergeQueryResult>;

/**
 * Adapt a plain page query (at most `limit` rows, fewer only at the partition's end) to a
 * {@link MergeQuery}: a short page is the end, and the last row is how far it read.
 */
export function pageQuery(
  query: (
    direction: Direction,
    opts: { readonly limit: number; readonly afterSk?: string },
  ) => Promise<readonly EmailSummary[]>,
): MergeQuery {
  return async (direction, opts) => {
    const rows = await query(direction, opts);
    return {
      rows,
      exhausted: rows.length < opts.limit,
      ...(rows.length > 0 ? { scannedToSk: rows[rows.length - 1].sk } : {}),
    };
  };
}

export interface ListEmailsParams {
  readonly query: MergeQuery;
  /** Restrict to one partition; omit for the merged sent + inbound timeline. */
  readonly direction?: Direction;
  /** Page size — the caller clamps this to the allowed range. */
  readonly limit: number;
  /** Opaque continuation token from a previous page. */
  readonly cursor?: string;
}

export interface MergedPage {
  readonly rows: readonly EmailSummary[];
  /** Absent → the timeline is exhausted. */
  readonly nextCursor?: string;
}

interface ListCursor {
  readonly v: 1;
  readonly sent?: string;
  readonly inbound?: string;
  readonly failed?: string;
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
  const positions: Partial<Record<Direction, string>> = {};
  for (const dir of ['sent', 'inbound', 'failed'] as const) {
    const value = raw[dir];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0) {
        throw emailErrors.invalidRequest('Invalid cursor.');
      }
      positions[dir] = value;
    }
  }
  return { v: 1, ...positions };
}

/** Descending sk order (newest first); total because sk carries the unique `#<id>` suffix. */
function bySkDescending(a: EmailSummary, b: EmailSummary): number {
  if (a.sk < b.sk) {
    return 1;
  }
  if (a.sk > b.sk) {
    return -1;
  }
  return 0;
}

/** Merge one page across the in-scope partitions and compute the continuation cursor. */
export async function listEmailsPage(params: ListEmailsParams): Promise<MergedPage> {
  const decoded = params.cursor ? decodeListCursor(params.cursor) : { v: 1 as const };
  const directions: Direction[] = params.direction ? [params.direction] : ['sent', 'inbound'];

  const fetched = {} as Record<Direction, MergeQueryResult>;
  for (const dir of directions) {
    fetched[dir] = await params.query(dir, { limit: params.limit, afterSk: decoded[dir] });
  }

  // Rows below an unfinished partition's frontier could be out of order with rows it hasn't
  // examined yet: emit only at or above the highest such frontier.
  let floor: string | undefined;
  for (const dir of directions) {
    const frontier = fetched[dir].exhausted ? undefined : fetched[dir].scannedToSk;
    if (frontier !== undefined && (floor === undefined || frontier > floor)) {
      floor = frontier;
    }
  }

  // Remember which listed partition each row was fetched from: a row's own `direction` can't
  // say (an Errors-folder row is a `direction: 'inbound'` message fetched as `failed`).
  const pool = directions.flatMap((dir) =>
    fetched[dir].rows
      .filter((row) => floor === undefined || row.sk >= floor)
      .map((row) => ({ dir, row })),
  );
  pool.sort((a, b) => bySkDescending(a.row, b.row));
  const page = pool.slice(0, params.limit);
  const rows = page.map((entry) => entry.row);

  const positions: Partial<Record<Direction, string>> = {};
  let anyMore = false;
  for (const dir of directions) {
    const result = fetched[dir];
    const emitted = page.filter((entry) => entry.dir === dir).map((entry) => entry.row);
    // When every fetched row made the page, resume below everything examined (for a plain
    // page that is its last row; for a filtered scan it skips the non-matching rows after the
    // last match). Otherwise resume after the last row emitted — the page is sk-descending, so
    // that is its lowest — or, if none was, where it started, re-fetching what lost the merge.
    const lastEmittedSk =
      emitted.length === result.rows.length
        ? (result.scannedToSk ?? emitted[emitted.length - 1]?.sk ?? decoded[dir])
        : emitted.length > 0
          ? emitted[emitted.length - 1].sk
          : decoded[dir];
    // ALWAYS carry this direction's continuation position — even if it drained this page.
    // Omitting it would make the next page restart the direction from the newest row
    // (re-emitting everything → dupes / non-termination). A drained direction simply
    // re-queries strictly after this sk next page and returns nothing. Undefined only when
    // it emitted nothing AND had no prior cursor (fully dominated on page 1) — then it
    // re-competes from the top next page, which re-fetches (never skips).
    if (lastEmittedSk !== undefined) {
      positions[dir] = lastEmittedSk;
    }
    // More remains unless the partition is done and every fetched row made the page.
    if (!result.exhausted || result.rows.length > emitted.length) {
      anyMore = true;
    }
  }
  const next: ListCursor = { v: 1, ...positions };

  return { rows, ...(anyMore ? { nextCursor: encodeListCursor(next) } : {}) };
}
