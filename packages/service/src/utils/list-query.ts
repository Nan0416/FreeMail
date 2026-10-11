/**
 * The single source of truth for validating `list emails` arguments — the `direction`
 * filter, the `limit` (defaulted + clamped to the shared page-size bounds), and the
 * opaque `cursor`. Both the REST `GET /emails` route and #13's `list_emails` MCP tool
 * call this, so their defaulting can never drift: a bad value throws the same
 * {@link emailErrors.invalidRequest} `EmailError` (REST maps it to 400, the MCP tool to an
 * `isError` tool-result).
 *
 * The MCP tool's input schema is stricter in front of this: it advertises `direction` as an
 * enum and `limit` as an integer from 1 to {@link MAX_EMAIL_PAGE_SIZE}, so an agent sees the
 * bounds up front, and the SDK rejects a value outside them (`limit: 150`, `direction: ''`)
 * before this runs, where REST clamps or ignores it.
 */
import {
  DEFAULT_EMAIL_PAGE_SIZE,
  MAX_EMAIL_PAGE_SIZE,
  MAX_LIST_FILTER_CHARS,
  type EmailListFilter,
  type EmailListFilters,
} from '@freemail/shared';
import { emailErrors } from './errors.js';
import type { ListEmailsServiceRequest } from '../services/email-read-service.js';

/** Untyped inputs as they arrive from either a query string (all strings) or MCP args. */
export interface RawListEmailsInput {
  readonly direction?: string | undefined;
  readonly limit?: string | number | undefined;
  readonly cursor?: string | undefined;
  readonly query?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
}

/** Validate + normalize raw inputs into a {@link ListEmailsServiceRequest}. */
export function parseListEmailsQuery(input: RawListEmailsInput): ListEmailsServiceRequest {
  const limit = parseLimit(input.limit);
  const direction = parseDirection(input.direction);
  const filters = parseFilters(input);
  // Cursor is opaque — validated when the read service decodes it. Empty string is treated as absent.
  return {
    limit,
    ...(direction ? { direction } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(filters ? { filters } : {}),
  };
}

/** The text and date filters, trimmed and normalized; undefined when none is set. */
function parseFilters(input: RawListEmailsInput): EmailListFilters | undefined {
  const query = parseText(input.query, 'query');
  const from = parseText(input.from, 'from');
  const to = parseText(input.to, 'to');
  const subject = parseText(input.subject, 'subject');
  const after = parseTime(input.after, 'after');
  const before = parseTime(input.before, 'before');
  if (after !== undefined && before !== undefined && after >= before) {
    throw emailErrors.invalidRequest('"after" must be earlier than "before".');
  }
  const filters: EmailListFilters = {
    ...(query !== undefined ? { query } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
  };
  return Object.keys(filters).length > 0 ? filters : undefined;
}

/** A text filter: trimmed, empty → absent, at most {@link MAX_LIST_FILTER_CHARS}. */
function parseText(raw: string | undefined, name: string): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length > MAX_LIST_FILTER_CHARS) {
    throw emailErrors.invalidRequest(
      `"${name}" may be at most ${MAX_LIST_FILTER_CHARS} characters.`,
    );
  }
  return value;
}

/** A date (`2026-10-01`, UTC midnight) or ISO-8601 date-time with a zone, normalized to UTC. */
const TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function parseTime(raw: string | undefined, name: string): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  const ms = TIME_RE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw emailErrors.invalidRequest(
      `"${name}" must be a date (2026-10-01) or an ISO-8601 time with a zone (2026-10-01T09:00:00Z).`,
    );
  }
  return new Date(ms).toISOString();
}

function parseDirection(raw: string | undefined): EmailListFilter | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (raw !== 'sent' && raw !== 'inbound' && raw !== 'failed') {
    throw emailErrors.invalidRequest('"direction" must be "sent", "inbound", or "failed".');
  }
  return raw;
}

/** A positive-integer page size, defaulted and clamped to the allowed range. */
function parseLimit(raw: string | number | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_EMAIL_PAGE_SIZE;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw emailErrors.invalidRequest('"limit" must be a positive integer.');
  }
  return Math.min(value, MAX_EMAIL_PAGE_SIZE);
}
