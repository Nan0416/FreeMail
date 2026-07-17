/**
 * The opaque message handle used by the read API. A stored message is addressed by an
 * encoded `{ pk, sk }` rather than a bare id, because the id alone can't locate the row
 * (the sort key is `<iso>#<id>` — we don't know the timestamp from the id). The list
 * mints the handle; the client only ever echoes it back.
 *
 * It is NOT a secret and NOT signed: FreeMail is single-tenant, so every row belongs to
 * the one owner and a crafted handle can only ever resolve to the owner's own mail or a
 * 404. The decode still validates the partition against the known set so a handle can't
 * point the GetItem at an arbitrary partition. A malformed handle fails as `not_found`
 * (indistinguishable from a missing row — nothing leaks about the id space).
 */
import { EMAIL_PARTITIONS } from '../data/emails-repo.js';
import { emailErrors } from './errors.js';

/** The primary-key pair a handle resolves to. */
export interface EmailRef {
  pk: string;
  sk: string;
}

interface EncodedRef {
  v: 1;
  pk: string;
  sk: string;
}

/** Mint the opaque handle for a stored row's primary key. */
export function encodeEmailRef(ref: EmailRef): string {
  const payload: EncodedRef = { v: 1, pk: ref.pk, sk: ref.sk };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a handle to its `{ pk, sk }`. Throws `not_found` on anything malformed — a bad
 * version, a non-string key, or a partition outside the known set.
 */
export function decodeEmailRef(handle: string): EmailRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(handle, 'base64url').toString('utf8'));
  } catch {
    throw emailErrors.notFound('No such message.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw emailErrors.notFound('No such message.');
  }
  const { v, pk, sk } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof pk !== 'string' || typeof sk !== 'string' || sk.length === 0) {
    throw emailErrors.notFound('No such message.');
  }
  if (!EMAIL_PARTITIONS.has(pk)) {
    throw emailErrors.notFound('No such message.');
  }
  return { pk, sk };
}
