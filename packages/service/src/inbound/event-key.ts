/**
 * Validating the S3 object key from the inbound event BEFORE trusting it. S3
 * notification keys are `application/x-www-form-urlencoded` (spaces as `+`, other
 * bytes percent-encoded), so we decode EXACTLY ONCE and then require the decoded
 * key to be `inbound/<message-id>` with a single trailing segment and a strict
 * message-id charset. The message id becomes both the DDB `id`/`sk` component and
 * an S3-key segment, so anything it can't safely be is rejected here.
 *
 * A key that fails validation is a HANDLED failure (logged, no-op) — never a
 * retryable error and never a DDB row, because there is no validated stable id to
 * key one on.
 */

/** SES delivers received mail under this prefix as `<prefix><messageId>`. */
export const INBOUND_PREFIX = 'inbound/';

/** SES message ids are conservative ASCII; anything outside this is rejected. */
const MESSAGE_ID_RE = /^[A-Za-z0-9._-]+$/;

export type EventKeyResult =
  { ok: true; messageId: string; rawS3Key: string } | { ok: false; reason: string };

/**
 * Decode an S3 event key exactly once (form-encoding: `+` → space, then
 * percent-decode). Returns null if the value is not decodable — a malformed
 * percent-escape is treated as an invalid key, not thrown.
 */
export function decodeEventKeyOnce(rawKey: string): string | null {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Validate a raw (still-encoded) S3 event key. On success returns the decoded key
 * and the extracted message id; on failure a reason for the diagnostic log.
 */
export function validateInboundEventKey(rawKey: string): EventKeyResult {
  const decoded = decodeEventKeyOnce(rawKey);
  if (decoded === null) {
    return { ok: false, reason: 'key is not decodable' };
  }
  if (!decoded.startsWith(INBOUND_PREFIX)) {
    return { ok: false, reason: `key not under ${INBOUND_PREFIX}` };
  }
  const messageId = decoded.slice(INBOUND_PREFIX.length);
  // A single trailing segment only — reject nested paths / traversal / empty id.
  if (messageId.length === 0 || messageId.includes('/')) {
    return { ok: false, reason: 'message id must be a single path segment' };
  }
  if (!MESSAGE_ID_RE.test(messageId)) {
    return { ok: false, reason: 'message id has an unexpected character' };
  }
  return { ok: true, messageId, rawS3Key: decoded };
}
