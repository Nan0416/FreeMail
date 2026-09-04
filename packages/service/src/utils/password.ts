/**
 * Password hashing with Node's built-in `scrypt`.
 *
 * Deliberately not argon2/bcrypt: both are native modules that must be compiled
 * for the exact Lambda runtime (AL2023, arm64/x64) and bundled — brittle in CI
 * and at deploy. `scrypt` ships in every Node/Lambda runtime, is memory-hard, and
 * is an OWASP-acceptable password KDF. For a single-tenant store guarding one
 * password, this is the clean, dependency-free, Lambda-safe choice.
 *
 * The encoded form is self-describing so cost parameters can change without a
 * migration: `scrypt$N$r$p$saltB64url$hashB64url`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Cost parameters. N*r*128 bytes of memory ≈ 16 MiB here — comfortably under
// scrypt's 32 MiB default `maxmem`, and interactive-fast for a rare login.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const SCHEME = 'scrypt';

function toB64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  // maxmem must exceed 128 * N * r; give headroom so raising N later doesn't throw.
  return scryptSync(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r });
}

/** Hash a password into the self-describing encoded form. A fresh random salt is used each call. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, N, R, P);
  return [SCHEME, N, R, P, toB64Url(salt), toB64Url(hash)].join('$');
}

/**
 * Verify a password against an encoded hash. Constant-time comparison; returns
 * false (never throws) on any malformed or mismatched input so callers can treat
 * "bad password" and "corrupt record" identically without leaking which.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) {
    return false;
  }
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
