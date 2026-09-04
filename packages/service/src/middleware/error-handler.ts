/**
 * The global Express error handler — the one place a thrown error becomes a response.
 * Registered after all routes; Express identifies error handlers by their four-argument
 * signature.
 *
 * `AuthError` and `EmailError` carry both the wire error code and the HTTP status, so the
 * services decide "why is this a 400" next to the logic that knows, and this handler just
 * renders that decision. `express.json()`'s own failures are translated too, so a
 * malformed or oversized body is a 400/413 with a wire code rather than Express's default
 * HTML error page. Anything else is a bug: logged, then flattened to a generic 500, so an
 * internal message or stack can never reach a caller.
 *
 * The response body shape is FreeMail's, not conduit's: `{ error: <code>, message }`,
 * because `AuthErrorBody` in `@freemail/shared` is the contract the SPA reads
 * (`web/src/api/client.ts` keys on `body.error`).
 *
 * SECURITY: the error is logged; the REQUEST is not. A log line carrying the `Cookie`
 * header would put a live session into CloudWatch.
 */
import type { AuthErrorBody } from '@freemail/shared';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AuthError } from '../utils/errors.js';
import { EmailError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('rest-error-handler');

/** `express.json()` tags its own failures with a `type`; `status` is set by http-errors. */
interface BodyParserError extends Error {
  readonly type?: string;
  readonly status?: number;
}

export const errorHandler: ErrorRequestHandler = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Express requires the four-argument signature to recognize an error handler at all.
  // `next` is not decoration: once the response has begun, the only correct move is to
  // delegate to Express's default handler, which destroys the socket. Trying to write a
  // second status line here would throw ERR_HTTP_HEADERS_SENT and mask the real error.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AuthError || err instanceof EmailError) {
    logger.warn(`${err.name} ${err.status} ${err.code}.`);
    if (err instanceof AuthError && err.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(err.retryAfterSeconds));
    }
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }

  const bodyParserError = asBodyParserError(err);
  if (bodyParserError) {
    res.status(bodyParserError.status).json(bodyParserError.body);
    return;
  }

  logger.error('Unhandled error in REST handler', err);
  res.status(500).json({
    error: 'invalid_request',
    message: 'Internal error.',
  } satisfies AuthErrorBody);
};

/**
 * Translate a body-parser rejection. These arrive before any route runs, so they must not
 * be reported as internal errors — the caller sent something we refused to parse.
 */
function asBodyParserError(
  err: Error,
): { readonly status: number; readonly body: AuthErrorBody } | undefined {
  const { type } = err as BodyParserError;
  if (type === 'entity.too.large') {
    return {
      status: 413,
      body: { error: 'invalid_request', message: 'Request body is too large.' },
    };
  }
  if (type === 'entity.parse.failed') {
    return {
      status: 400,
      body: { error: 'invalid_request', message: 'Request body must be valid JSON.' },
    };
  }
  return undefined;
}
