/**
 * API-key format: mint, parse, and constant-time verify.
 *
 * A raw key is `fm_<keyId>_<secret>`. The `secret` half is 256 bits of
 * randomness, so — exactly like the opaque refresh token — SHA-256 is the right
 * hash: there is nothing to brute-force, and the slow scrypt KDF is only needed
 * for the low-entropy human password. The public `keyId` keys the stored row so a
 * presented key can be looked up before its secret is checked; only the secret's
 * hash is ever persisted, and the raw key is shown to the user exactly once.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_KEY_PREFIX } from '@freemail/shared';

/** 96-bit public lookup id, hex-encoded — the DynamoDB partition key. */
const KEY_ID_BYTES = 12;
/** 256-bit secret half, base64url-encoded. */
const SECRET_BYTES = 32;

export interface GeneratedApiKey {
  /** Public lookup id — persisted as the partition key. */
  keyId: string;
  /** The full raw key to return to the caller once. */
  key: string;
  /** SHA-256 (hex) of the secret half — the only part of the credential persisted. */
  secretHash: string;
}

/** Mint a fresh key. `key` is returned once; only `keyId` + `secretHash` are stored. */
export function generateApiKey(): GeneratedApiKey {
  const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    keyId,
    key: `${API_KEY_PREFIX}${keyId}_${secret}`,
    secretHash: hashApiKeySecret(secret),
  };
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

/**
 * Split a presented raw key into its lookup id and secret, or null if it is not a
 * well-formed FreeMail key. `keyId` is hex, so the first `_` after the prefix is an
 * unambiguous separator even though the base64url secret may itself contain `_`.
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  if (!raw.startsWith(API_KEY_PREFIX)) {
    return null;
  }
  const rest = raw.slice(API_KEY_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator <= 0) {
    return null;
  }
  const keyId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!/^[0-9a-f]+$/.test(keyId) || secret.length === 0) {
    return null;
  }
  return { keyId, secret };
}

/** Deterministic hash used both to store a minted secret and to compare a presented one. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Constant-time check of a presented secret against a stored hash. Returns false
 * (never throws) on any mismatch or malformed stored hash, so a caller cannot
 * distinguish "wrong secret" from "corrupt record" by outcome or timing.
 */
export function verifyApiKeySecret(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKeySecret(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
