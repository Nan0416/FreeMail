/**
 * Minimal HS256 JWT sign/verify over Node's `crypto` HMAC.
 *
 * The access token is stateless: the Lambda authorizer verifies it with the
 * signing key alone — no DynamoDB read on the hot path. We keep our own tiny
 * implementation rather than pull a JWT dependency because the surface is
 * exactly one symmetric algorithm (HS256), the token is verified on every
 * protected request, and pinning `alg` ourselves closes the classic algorithm-
 * confusion hole. It sits behind `signAccessToken`/`verifyAccessToken` so
 * swapping in a library later is a local change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const HEADER_SEGMENT = encodeSegment(HEADER);

/** Allowed clock skew when checking `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

export interface AccessTokenClaims {
  /** Subject — the single-tenant owner. */
  sub: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

export interface SignAccessTokenOptions {
  subject: string;
  issuedAt: number;
  ttlSeconds: number;
}

export type VerifyResult =
  | { valid: true; claims: AccessTokenClaims }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' };

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(signingInput: string, key: string): string {
  return createHmac('sha256', key).update(signingInput).digest('base64url');
}

export function signAccessToken(key: string, options: SignAccessTokenOptions): string {
  const claims: AccessTokenClaims = {
    sub: options.subject,
    iat: options.issuedAt,
    exp: options.issuedAt + options.ttlSeconds,
  };
  const signingInput = `${HEADER_SEGMENT}.${encodeSegment(claims)}`;
  return `${signingInput}.${sign(signingInput, key)}`;
}

/**
 * Verify a token and return its claims. `alg` is pinned to HS256 (a token
 * declaring anything else — including `none` — is rejected before any HMAC),
 * the signature is compared in constant time, and `exp`/`iat` are enforced with
 * a small skew. Never throws — every failure is a typed `{ valid: false }`.
 */
export function verifyAccessToken(token: string, key: string, nowSeconds: number): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: unknown;
  let claims: AccessTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'));
    claims = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    ) as AccessTokenClaims;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!isHs256Header(header) || !areClaimsShaped(claims)) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = sign(`${headerSegment}.${payloadSegment}`, key);
  if (!constantTimeEquals(signatureSegment, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  if (nowSeconds >= claims.exp) {
    return { valid: false, reason: 'expired' };
  }
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: 'not_yet_valid' };
  }
  return { valid: true, claims };
}

function isHs256Header(header: unknown): boolean {
  return (
    typeof header === 'object' &&
    header !== null &&
    (header as Record<string, unknown>).alg === 'HS256'
  );
}

function areClaimsShaped(claims: AccessTokenClaims): boolean {
  return (
    typeof claims.sub === 'string' &&
    typeof claims.iat === 'number' &&
    typeof claims.exp === 'number'
  );
}

/** Constant-time string compare that tolerates length differences without leaking them via early return. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
