/**
 * REST API Lambda for the React app — the entry point, and nothing else.
 *
 * One HTTP API (payload v2) integration fronts every REST route through a single Express
 * app; a single-tenant, low-traffic app does not need a Lambda per route. The app is built
 * ONCE per execution environment and reused across warm invocations, so the DynamoDB, S3,
 * and SES clients are constructed at cold start rather than per request.
 *
 * Everything this file names lives elsewhere on purpose:
 *   - `service-config.ts`      the environment contract, validated once
 *   - `dependencies/`          what the routes talk to
 *   - `routes/*-endpoints.ts`  the route table, one Express Router per domain surface
 *   - `middleware/`            the cross-cutting stages
 *   - `service.ts`             how those three are composed into an app
 *
 * ROUTE PATTERNS ARE DECLARED TWICE, in two syntaxes: `ApiConstruct` registers
 * `/emails/{id}` with API Gateway, and `EmailEndpoints` registers `/emails/:id` with
 * Express. They cannot share a constant. `tests/handlers/service-handler.test.ts` drives
 * every one of them through a real API Gateway v2 event so a drift fails a test rather
 * than 404ing in production.
 *
 * The MCP server (#7) is a separate handler on the same HTTP API, behind the same
 * dual-scheme authorizer, and is assembled from these same pieces — see `mcp.ts`.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { DependencyFactory } from '../dependencies/index.js';
import { authMiddleware, errorHandler, notFoundHandler } from '../middleware/index.js';
import {
  AuthEndpoints,
  DownloadEndpoints,
  EmailEndpoints,
  KeysEndpoints,
} from '../routes/index.js';
import { FreeMailService } from './service.js';
import { getServiceConfig } from './service-config.js';
import { toApiGatewayHandler, type ApiGatewayHandler } from './serverless-express.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('rest-lambda');

let apigHandler: ApiGatewayHandler | undefined;

function buildHandler(): ApiGatewayHandler {
  if (apigHandler) {
    logger.debug('Reusing lambda instance.');
    return apigHandler;
  }

  logger.info('Creating new lambda handler instance.');

  const config = getServiceConfig();
  const deps = new DependencyFactory(config).build();

  const service = new FreeMailService({
    middleware: [authMiddleware],
    endpoints: [
      new AuthEndpoints(deps.authService),
      new KeysEndpoints(deps.apiKeyService),
      new EmailEndpoints(deps.emailService, deps.emailReadService, deps.attachmentUploadService),
      new DownloadEndpoints(deps.downloadService),
    ],
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
    logger.error('Failed to build the REST handler', error);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_request', message: 'Internal error.' }),
    };
  }
};
