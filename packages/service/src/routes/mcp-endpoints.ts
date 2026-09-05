/**
 * The MCP server's route table — one route, `POST /mcp`.
 *
 * Stateless mode (`sessionIdGenerator: undefined` + `enableJsonResponse: true`) means each
 * invocation is an independent request/response JSON exchange, which is exactly the Lambda
 * model: no sessions, no SSE. Only POST is registered, matching `ApiConstruct`'s route.
 *
 * A FRESH server + transport PER REQUEST, never a warm singleton. That is not a style
 * preference — the SDK makes the alternative unsafe in two distinct ways:
 *
 *   1. `Protocol.connect()` THROWS if a transport is already attached, and only the
 *      transport's `close()` detaches it. A cached server would therefore depend on every
 *      path — error paths included — reaching `close()`. Miss it once and that warm
 *      container throws "Already connected to a transport" on every subsequent invocation
 *      until Lambda recycles it: a sticky per-instance outage that surfaces as intermittent
 *      failures across the fleet.
 *   2. `Server._clientCapabilities` / `_clientVersion` are set on `initialize` and are NOT
 *      cleared when the connection closes, so a reused server would carry one caller's
 *      declared capabilities into the next caller's request.
 *
 * And there is nothing to gain in exchange. The tool schemas are module-scope constants in
 * `mcp/server.ts`, and the SDK's zod-to-JSON-Schema conversion runs inside its `tools/list`
 * handler — per request, warm or cold. The collaborators that ARE expensive (the DynamoDB,
 * S3, and SES clients) are cached across invocations by `McpDependencyFactory`, which is
 * where the cold-start cost actually lived.
 *
 * `req.body` is handed to the transport as `parsedBody` because the app-level
 * `express.json()` has already consumed the request stream; given it, the SDK skips its own
 * body read. One consequence is deliberate: a MALFORMED JSON body is now rejected by
 * `express.json()` as a 400 in FreeMail's `{ error, message }` shape, rather than reaching
 * the transport and coming back as a JSON-RPC `-32700`. Same status, same "your body was
 * not JSON" meaning, and it buys one error-rendering path for the whole service.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { requireAuthenticated } from '../middleware/auth-middleware.js';
import { requireJsonContentType } from '../middleware/json-content-type.js';
import { buildMcpServer, type McpServerDeps } from '../mcp/server.js';
import { getLogger } from '../utils/logger.js';
import type { Endpoints } from './endpoints.js';

const logger = getLogger('McpEndpoints');

export class McpEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(deps: McpServerDeps) {
    this.router = Router();

    // #47 Layer 3: POST /mcp is a cookie-reachable state-changing route, so it must be a
    // NON-SIMPLE request — a same-site sibling must not be able to form-POST it. JSON-RPC
    // is JSON by definition, so every real MCP client already sends this; a no-`Origin`
    // agent call with `x-api-key` is unaffected. Both guards run before the server and
    // transport are built, so nothing is constructed for a request we are going to refuse.
    this.router.post(
      '/mcp',
      requireJsonContentType,
      requireAuthenticated,
      async (req: Request, res: Response, next: NextFunction) => {
        logger.info('POST /mcp.');
        const server = buildMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          // The transport renders protocol-level failures itself; this is for the case
          // where it could not. `errorHandler` delegates to Express once headers are sent.
          next(err);
        } finally {
          // Closing the server closes its connected transport.
          await server.close();
        }
      },
    );
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
