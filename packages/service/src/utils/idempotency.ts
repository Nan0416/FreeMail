/**
 * Idempotent sends: a caller that retries a send (a timeout, a dropped connection, an agent
 * unsure whether its tool call landed) passes the same `idempotencyKey`, and a repeat of the
 * same request within {@link IDEMPOTENCY_KEY_TTL_SECONDS} returns the first send's result
 * instead of sending again.
 *
 * A key is remembered with a fingerprint of the request it was first used for, so the same key
 * on a DIFFERENT message is refused rather than silently answered with the first one's result.
 */
import { createHash } from 'node:crypto';
import type { SendEmailRequest } from '@freemail/shared';

/** 1–128 characters a caller can generate without escaping: letters, digits, `._:-`. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_RE.test(value);
}

/**
 * A stable fingerprint of what a send asks for — every field but the key itself, with object
 * keys sorted, so the same request always hashes the same however its JSON was ordered.
 */
export function requestFingerprint(request: SendEmailRequest): string {
  const rest: Record<string, unknown> = { ...request };
  delete rest.idempotencyKey;
  return createHash('sha256').update(canonicalJson(rest)).digest('base64url');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
