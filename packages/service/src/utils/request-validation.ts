/**
 * Runtime validation for untrusted request data, in the spirit of conduit's
 * `utils/assertions.ts`. Use these instead of `as` casts at the HTTP boundary.
 *
 * Every helper fails with an `AuthError` (`invalid_request`, 400) rather than a raw
 * `TypeError`, so a malformed request is a 400 carrying a wire error code and never a
 * 500. `express.json()` has already turned the body into an object by the time these run;
 * what it cannot do is tell us whether the fields we need are actually there.
 */
import type { Request } from 'express';
import { authErrors } from './errors.js';

/**
 * The parsed JSON body as an object. `express.json()` yields `{}` for an absent body and
 * rejects malformed JSON before the route runs, so the only case left to reject here is a
 * body that parsed to a non-object (a bare array, string, or number).
 */
export function requireBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw authErrors.invalidRequest('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** A required non-empty string field. */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw authErrors.invalidRequest(`"${field}" is required.`);
  }
  return value;
}

/** An optional string field: undefined when absent, but a wrong type is still a 400. */
export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw authErrors.invalidRequest(`"${field}" must be a string.`);
  }
  return value;
}

/**
 * A required path parameter. Express only runs the route when the pattern matched, so an
 * absent value means the route pattern and the handler disagree — a 400 is the honest
 * answer either way, and it never reaches a service.
 */
export function requirePathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw authErrors.invalidRequest(`Path parameter "${name}" is required.`);
  }
  return value;
}
