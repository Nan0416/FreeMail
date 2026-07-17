/**
 * httpOnly session cookies for the human/web surface (#31). Both the access JWT and
 * the rotating refresh token are delivered as cookies the browser stores but page
 * JavaScript cannot read (`HttpOnly`) — so an XSS payload can neither exfiltrate a
 * token nor find one in `localStorage`/`sessionStorage`. `SameSite=Strict` is the
 * CSRF defense: a cross-site request cannot ride the cookies, which is why the SPA
 * is served SAME-ORIGIN with the API (the CloudFront `/api/*` proxy) — a
 * double-submit token is deferred behind that. The `__Host-` name prefix pins each
 * cookie to `Secure` + `Path=/` + no `Domain`, so a sibling host cannot shadow it.
 *
 * These are pure serializers/parsers (no AWS), shared by the REST handler (which
 * sets/clears them) and the Lambda authorizer (which reads the access cookie).
 */
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '@freemail/shared';

export const ACCESS_COOKIE = '__Host-fm_access';
export const REFRESH_COOKIE = '__Host-fm_refresh';

// `__Host-` REQUIRES exactly these attributes: Secure, Path=/, and no Domain.
// HttpOnly keeps the value out of JS; SameSite=Strict blocks cross-site delivery.
const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';

function serialize(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
}

/** The `Set-Cookie` values for a freshly issued/rotated session (login + refresh). */
export function sessionCookies(accessToken: string, refreshToken: string): string[] {
  return [
    serialize(ACCESS_COOKIE, accessToken, ACCESS_TOKEN_TTL_SECONDS),
    serialize(REFRESH_COOKIE, refreshToken, REFRESH_TOKEN_TTL_SECONDS),
  ];
}

/**
 * `Set-Cookie` values that expire BOTH session cookies immediately (empty value +
 * `Max-Age=0`, same name/attributes). Used on logout and on every refresh failure,
 * so a bad session can never be left half-populated.
 */
export function clearSessionCookies(): string[] {
  return [serialize(ACCESS_COOKIE, '', 0), serialize(REFRESH_COOKIE, '', 0)];
}

/** Returned by {@link readCookie} when a name appears more than once (reject, don't guess). */
export const DUPLICATE_COOKIE = Symbol('duplicate-cookie');

/**
 * Read exactly one cookie value from the API Gateway v2 `cookies` array (each entry
 * is `name=value`; the value is split on the FIRST `=` so a base64/`.`-bearing token
 * survives intact). Resistant to shadowing/injection: a name appearing MORE THAN
 * ONCE returns {@link DUPLICATE_COOKIE} rather than silently picking the first or
 * last, so an attacker cannot smuggle a second same-name cookie past the authorizer.
 * Absent → `null`; exactly one → its value.
 */
export function readCookie(
  cookies: readonly string[] | undefined,
  name: string,
): string | null | typeof DUPLICATE_COOKIE {
  if (!cookies) {
    return null;
  }
  let found: string | null = null;
  for (const entry of cookies) {
    const eq = entry.indexOf('=');
    if (eq < 0) {
      continue;
    }
    if (entry.slice(0, eq).trim() !== name) {
      continue;
    }
    if (found !== null) {
      return DUPLICATE_COOKIE;
    }
    found = entry.slice(eq + 1);
  }
  return found;
}
