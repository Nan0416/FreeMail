/**
 * Reads the Lambda authorizer's context and attaches it to `req.authContext`, plus the
 * per-route guards that act on it. serverless-express exposes the original API Gateway
 * event via `getCurrentInvoke()`, which is where the authorizer's output lives — Express
 * never sees it otherwise.
 *
 * Like conduit's `authMiddleware`, this only ATTACHES; it never rejects. The public routes
 * (`/auth/*`, `GET /d/{token}`) legitimately arrive with no authorizer context, and
 * rejecting here would break them. Refusal is a per-route decision, made by the guards.
 */
import { getCurrentInvoke } from '@codegenie/serverless-express';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authErrors } from '../utils/errors.js';
import { optionalSubjectFromContext, schemeFromContext } from '../utils/request-context.js';

/** What the Lambda authorizer resolved for this request. */
export interface AuthContext {
  /** The authenticated subject (always the single tenant's owner today). */
  readonly subject: string;
  /** The credential scheme the authorizer matched: `access` | `apiKey`. */
  readonly scheme: string | undefined;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Attached by {@link authMiddleware}; absent on the public routes. */
    readonly authContext?: AuthContext;
  }
}

/**
 * Declared `readonly` on `Request` so no route can rewrite the caller's identity
 * mid-request. This is the single writer.
 */
function attachAuthContext(req: Request, context: AuthContext): void {
  (req as { authContext?: AuthContext }).authContext = context;
}

export const authMiddleware: RequestHandler = (req, _res, next) => {
  const event = getCurrentInvoke().event as APIGatewayProxyEventV2 | undefined;
  const subject = event ? optionalSubjectFromContext(event) : undefined;
  if (event && subject !== undefined) {
    attachAuthContext(req, { subject, scheme: schemeFromContext(event) });
  }
  next();
};

/**
 * The authenticated subject, for routes behind the authorizer. The authorizer guards those
 * routes, so this should always be present; fail loud rather than emit an empty subject if
 * the wiring ever regresses.
 */
export function getAuthContext(req: Request): AuthContext {
  if (!req.authContext) {
    throw authErrors.invalidToken();
  }
  return req.authContext;
}

/**
 * Guard: only a Bearer access token (the human, via the app) may reach this route. An
 * `x-api-key`-authenticated caller is authenticated but must NOT be able to escalate to
 * managing the account's key set or to reading the mailbox over REST — so anything other
 * than the `access` scheme is forbidden. Fails closed on a missing scheme, and on a
 * request with no authorizer context at all.
 */
export function requireAccessScheme(req: Request, _res: Response, next: NextFunction): void {
  if (req.authContext?.scheme !== 'access') {
    next(authErrors.forbidden('API keys cannot manage API keys.'));
    return;
  }
  next();
}

/**
 * Guard: the caller must have been authenticated by the Lambda authorizer, under EITHER
 * scheme. This is the MCP route's guard: an `x-api-key` agent and a Bearer human are
 * equally legitimate there, because `send_email` is the same capability as `POST /emails`
 * — so unlike {@link requireAccessScheme} it does not discriminate on scheme, only on
 * whether an identity was resolved at all.
 *
 * The authorizer already guards that route, so this is defense-in-depth: it fails closed if
 * that wiring ever regresses, and documents that the caller's identity comes ONLY from the
 * authorizer context, never from tool input.
 */
export function requireAuthenticated(req: Request, _res: Response, next: NextFunction): void {
  if (!req.authContext) {
    next(authErrors.invalidToken());
    return;
  }
  next();
}
