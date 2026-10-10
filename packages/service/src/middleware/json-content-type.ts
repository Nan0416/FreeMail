/**
 * #47 Layer 3 — the request-SHAPE gate.
 *
 * Routes that mutate state must be NON-SIMPLE requests. Requiring `application/json`
 * forces a browser to preflight them, which the API's exact-origin CORS policy (Layer 2)
 * then refuses for a same-site sibling — and it rejects the plain `<form>`-POST path,
 * which never preflights, outright.
 *
 * Applied as the FIRST handler on each gated route, so a wrongly-shaped request is refused
 * before the route body reads a table, writes a row, or — critically for refresh/logout —
 * rotates or revokes a session. A 415 that had already cleared the session cookies would
 * be a forced-logout DoS wearing an error code.
 *
 * It is a shape rule, uniform regardless of `Origin`. It is NOT origin checking and NOT
 * authorization: the Lambda authorizer remains the sole authorization boundary, and a
 * no-`Origin` agent call with `x-api-key` passes untouched (the API is JSON-only, so
 * agents already send this content type).
 *
 * THE GATED ROUTES:
 *   POST /auth/login   POST /auth/refresh   POST /auth/logout   POST /keys   POST /emails
 *
 * `POST /auth/refresh` and `POST /auth/logout` are gated even though they are BODYLESS:
 * they are cookie-authenticated state changes and are otherwise "simple" requests, so a
 * sibling form-POST could ride the session cookie to force a logout. The SPA deliberately
 * sends the header on them.
 *
 * `DELETE /keys/{id}` is deliberately NOT gated: DELETE is already non-simple by method,
 * so a content-type requirement on a bodyless DELETE would be pure theater. Reads are
 * ungated for the same reason — they change nothing.
 *
 * `JSON_REQUIRED_ROUTES` below is the auditable list FOR THE REST APP;
 * `tests/handlers/service-handler.test.ts` asserts that the REST routes wearing this
 * middleware are exactly the routes in it. The MCP app is a separate Express app with a
 * single route, `POST /mcp`, which wears this same middleware for the same reason — it is
 * audited by `tests/handlers/mcp-handler.test.ts` rather than by that set, which would
 * otherwise claim a route the REST app does not serve.
 */
import type { NextFunction, Request, Response } from 'express';
import { authErrors } from '../utils/errors.js';
import { isJsonContentType } from '../utils/content-type.js';

/** The routes that must carry `Content-Type: application/json`, as API Gateway route keys. */
export const JSON_REQUIRED_ROUTES: ReadonlySet<string> = new Set([
  'POST /auth/login',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /keys',
  'POST /emails',
  'POST /attachments/uploads',
]);

export function requireJsonContentType(req: Request, _res: Response, next: NextFunction): void {
  if (!isJsonContentType(req.headers['content-type'])) {
    next(authErrors.unsupportedMediaType());
    return;
  }
  next();
}
