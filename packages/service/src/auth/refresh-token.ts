/**
 * Opaque refresh tokens. Unlike the access token, the refresh token is *not* a
 * JWT — it is a high-entropy random string whose SHA-256 is stored in DynamoDB.
 * That makes rotation and revocation database facts (delete/replace the row)
 * rather than signature games, which is what "refresh rotation + reuse detection"
 * needs. A DB leak exposes only hashes, never usable tokens.
 *
 * SHA-256 (not scrypt) is correct here: the token is 256 bits of randomness, so
 * there is nothing to brute-force — the slow KDF is only needed for the low-
 * entropy human password.
 */
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const PREFIX = 'rt_';

/** Mint a new opaque refresh token (returned once to the client; only its hash is persisted). */
export function generateRefreshToken(): string {
  return PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Deterministic lookup key for a refresh token. Store and query by this, never the raw token. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
