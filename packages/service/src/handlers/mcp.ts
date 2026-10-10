/**
 * MCP server Lambda — the entry point, and nothing else.
 *
 * A separate handler from the REST API (`service-handler.ts`) but on the SAME HTTP API
 * behind the SAME dual-scheme authorizer (#5), so an agent's `x-api-key` (or a Bearer
 * human) authenticates identically — and assembled the SAME way: one Express app composed
 * by `FreeMailService`, wrapped by serverless-express. There is no bespoke API Gateway
 * event adapter here any more, and no second way to render an error.
 *
 * Everything this file names lives elsewhere on purpose:
 *   - `mcp-config.ts`            the environment contract, validated once
 *   - `dependencies/`            what the tools talk to
 *   - `routes/mcp-endpoints.ts`  the route table, and why the MCP server is per-request
 *   - `middleware/`              the cross-cutting stages, shared with the REST app
 *   - `service.ts`               how those are composed into an app
 *
 * The APP is built ONCE per execution environment and reused across warm invocations, so
 * the DynamoDB, S3, and SES clients are constructed at cold start rather than per request.
 * The MCP SERVER deliberately is NOT cached — see `routes/mcp-endpoints.ts` for why a warm
 * singleton would be both unsafe and pointless.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { McpDependencyFactory } from '../dependencies/index.js';
import {
  authMiddleware,
  errorHandler,
  notFoundHandler,
  preserveWriteHeadHeaders,
} from '../middleware/index.js';
import { McpEndpoints } from '../routes/index.js';
import type { McpServerDeps } from '../mcp/server.js';
import { FreeMailService } from './service.js';
import { getMcpConfig } from './mcp-config.js';
import { toApiGatewayHandler, type ApiGatewayHandler } from './serverless-express.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-lambda');

let apigHandler: ApiGatewayHandler | undefined;

function buildHandler(): ApiGatewayHandler {
  if (apigHandler) {
    logger.debug('Reusing lambda instance.');
    return apigHandler;
  }

  logger.info('Creating new MCP handler instance.');

  const deps = new McpDependencyFactory(getMcpConfig()).build();
  const serverDeps: McpServerDeps = {
    emailService: deps.emailService,
    inboundEnabled: deps.inboundEnabled,
    ...(deps.readService ? { readService: deps.readService } : {}),
  };

  const service = new FreeMailService({
    // `preserveWriteHeadHeaders` FIRST: it must wrap `res` before the transport writes.
    middleware: [preserveWriteHeadHeaders, authMiddleware],
    endpoints: [new McpEndpoints(serverDeps)],
    notFoundHandler,
    errorHandler,
  });

  apigHandler = toApiGatewayHandler(service.init());
  return apigHandler;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const processor = buildHandler();
    return await processor(event, context, () => {});
  } catch (error) {
    // Express handles every in-request error internally. This catch exists for
    // `buildHandler()`, which throws on a misconfigured deployment (a missing environment
    // variable), so that surfaces as a logged, structured 500 rather than an opaque
    // Lambda init failure.
    logger.error('Failed to build the MCP handler', error);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', message: 'Internal error.' }),
    };
  }
};
