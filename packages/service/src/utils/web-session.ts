/**
 * The Express-facing half of the httpOnly session cookies (#31). The serializers
 * themselves live in `utils/cookies.ts` and stay framework-free (the Lambda authorizer
 * shares them); this file is only about getting them on and off an Express
 * request/response.
 *
 * Reading goes through `getCurrentInvoke()` rather than `req.headers.cookie` ON PURPOSE.
 * API Gateway v2 delivers cookies as an ARRAY, and serverless-express flattens that array
 * into a single `Cookie:` header before Express ever sees it. FreeMail rejects a
 * duplicated session cookie instead of guessing which copy is real (see
 * {@link readCookie} / `DUPLICATE_COOKIE`) — an attacker who can set a cookie on a
 * sibling host must not be able to smuggle a second `__Host-fm_refresh` past us. Once the
 * array is joined, "one cookie named X" and "two cookies named X" are much harder to tell
 * apart, so we read the original event and keep the array.
 */
import { getCurrentInvoke } from '@codegenie/serverless-express';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Response } from 'express';
import { REFRESH_COOKIE, clearSessionCookies, readCookie, sessionCookies } from './cookies.js';

/** The invoking API Gateway event, or undefined outside a Lambda invocation. */
function currentEvent(): APIGatewayProxyEventV2 | undefined {
  return getCurrentInvoke().event as APIGatewayProxyEventV2 | undefined;
}

/**
 * The presented refresh token, read ONLY from the `__Host-fm_refresh` cookie — never a
 * body or query parameter. Absent and duplicated both yield null: a duplicate is treated
 * exactly like an absent cookie, rejected rather than guessed.
 */
export function readRefreshCookie(): string | null {
  const value = readCookie(currentEvent()?.cookies, REFRESH_COOKIE);
  return typeof value === 'string' ? value : null;
}

/** API Gateway's resolved `"<METHOD> <path template>"` for this request. */
export function currentRouteKey(): string | undefined {
  return currentEvent()?.routeKey;
}

/** Set both session cookies for a freshly issued or rotated session. */
export function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  for (const cookie of sessionCookies(accessToken, refreshToken)) {
    res.append('Set-Cookie', cookie);
  }
}

/**
 * Expire BOTH session cookies. The tokens are httpOnly, so only a `Set-Cookie` can clear
 * the browser's copy — this is emitted on logout and on EVERY refresh failure, so a bad
 * session is never left half-populated.
 */
export function clearSession(res: Response): void {
  for (const cookie of clearSessionCookies()) {
    res.append('Set-Cookie', cookie);
  }
}

/** Marks a response as never cacheable. Required on anything that carries or clears a credential. */
export function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}
