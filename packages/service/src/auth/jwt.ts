/**
 * HS256 access-token sign/verify via `jose`.
 *
 * The access token is stateless: the Lambda authorizer verifies it with the
 * signing key alone — no DynamoDB read on the hot path. `jose` owns the JWS
 * parsing/canonicalization/verification surface; we pin the algorithm to HS256
 * (rejecting `none`/downgrade) and keep everything behind
 * `signAccessToken`/`verifyAccessToken` so the token format stays swappable.
 */
import { SignJWT, errors, jwtVerify } from 'jose';

export interface AccessTokenClaims {
  /** Subject — the single-tenant owner. */
  readonly sub: string;
  /** Issued-at (epoch seconds). */
  readonly iat: number;
  /** Expiry (epoch seconds). */
  readonly exp: number;
}

export interface SignAccessTokenOptions {
  readonly subject: string;
  readonly issuedAt: number;
  readonly ttlSeconds: number;
}

export type VerifyResult =
  | { readonly valid: true; readonly claims: AccessTokenClaims }
  | { readonly valid: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' };

function encodeKey(key: string): Uint8Array {
  return new TextEncoder().encode(key);
}

export async function signAccessToken(
  key: string,
  options: SignAccessTokenOptions,
): Promise<string> {
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(options.subject)
    .setIssuedAt(options.issuedAt)
    .setExpirationTime(options.issuedAt + options.ttlSeconds)
    .sign(encodeKey(key));
}

/**
 * Verify a token and return its claims. The algorithm is pinned to HS256 (a token
 * declaring anything else — including `none` — is rejected), and `exp` is checked
 * against `nowSeconds` so tests are deterministic. Never throws — every failure is
 * a typed `{ valid: false }`.
 */
export async function verifyAccessToken(
  token: string,
  key: string,
  nowSeconds: number,
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, encodeKey(key), {
      algorithms: ['HS256'],
      currentDate: new Date(nowSeconds * 1000),
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      return { valid: false, reason: 'malformed' };
    }
    return { valid: true, claims: { sub: payload.sub, iat: payload.iat, exp: payload.exp } };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { valid: false, reason: 'expired' };
    }
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      return { valid: false, reason: 'bad_signature' };
    }
    return { valid: false, reason: 'malformed' };
  }
}
