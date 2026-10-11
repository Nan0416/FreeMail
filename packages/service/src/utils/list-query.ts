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
  type EmailListFilter,
} from '@freemail/shared';
import { emailErrors } from './errors.js';
import type { ListEmailsServiceRequest } from '../services/email-read-service.js';

/** Untyped inputs as they arrive from either a query string (all strings) or MCP args. */
export interface RawListEmailsInput {
  readonly direction?: string | undefined;
  readonly limit?: string | number | undefined;
  readonly cursor?: string | undefined;
}

/** Validate + normalize raw inputs into a {@link ListEmailsServiceRequest}. */
export function parseListEmailsQuery(input: RawListEmailsInput): ListEmailsServiceRequest {
  const limit = parseLimit(input.limit);
  const direction = parseDirection(input.direction);
  // Cursor is opaque — validated when the read service decodes it. Empty string is treated as absent.
  return {
    limit,
    ...(direction ? { direction } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
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
