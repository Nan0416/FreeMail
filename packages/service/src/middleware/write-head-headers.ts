/**
 * Keeps response headers that `writeHead()` would otherwise silently drop.
 *
 * THE INTERACTION, precisely. serverless-express hands Express a `ServerlessResponse`,
 * whose `writeHead` override exists to record headers into a side channel the Lambda result
 * is later built from. But Express's own `init` middleware does
 * `setPrototypeOf(res, app.response)`, and `app.response` descends from
 * `http.ServerResponse.prototype` — NOT from `ServerlessResponse.prototype`. So inside a
 * route `res instanceof ServerlessResponse` is already false and `res.writeHead` is the
 * NATIVE implementation: the override is cut out of the prototype chain before any handler
 * runs. Native `writeHead(status, headers)` writes those headers only into the raw HTTP
 * header block, which serverless-express's fake socket parses off and discards, and they
 * never reach `getHeaders()` — so they never reach API Gateway.
 *
 * Express's own responses are unaffected: `res.json()` / `res.set()` go through
 * `setHeader()`, which lands in the outgoing-headers map that `getHeaders()` does return.
 * The MCP route is the one that cares, because the SDK's Node transport delegates to
 * `@hono/node-server`, which sets EVERY response header via `writeHead(status, headers)`
 * and none via `setHeader`. Without this, an MCP reply reaches the client with no
 * `content-type` at all.
 *
 * The fix is to mirror the header object into `setHeader()` before delegating, which is
 * exactly what the shadowed override would have done. Applied only to the MCP app: the REST
 * app never calls `writeHead` with a header object, so carrying it there would be dead
 * weight pretending to be a safety net.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';

type WriteHeadHeaders = OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined;

export const preserveWriteHeadHeaders: RequestHandler = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const writeHead = res.writeHead.bind(res);

  function patched(statusCode: number, headers?: WriteHeadHeaders): Response;
  function patched(statusCode: number, reason: string, headers?: WriteHeadHeaders): Response;
  function patched(
    statusCode: number,
    reasonOrHeaders?: string | WriteHeadHeaders,
    maybeHeaders?: WriteHeadHeaders,
  ): Response {
    const headers = typeof reasonOrHeaders === 'string' ? maybeHeaders : reasonOrHeaders;
    // Only the object form is mirrored. The raw-array form is a flat [name, value, ...]
    // list that Node writes verbatim; nothing in this service produces one.
    if (headers && !Array.isArray(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) {
          res.setHeader(name, value);
        }
      }
    }
    return typeof reasonOrHeaders === 'string'
      ? writeHead(statusCode, reasonOrHeaders, maybeHeaders as OutgoingHttpHeaders)
      : (writeHead(statusCode, reasonOrHeaders as OutgoingHttpHeaders) as Response);
  }

  res.writeHead = patched as typeof res.writeHead;
  next();
};
