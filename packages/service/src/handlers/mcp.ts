/**
 * MCP server Lambda — the entry point, and nothing else.
 *
 * A separate handler from the REST API (`service-handler.ts`) but on the SAME HTTP API
 * behind the SAME dual-scheme authorizer (#5), so an agent's `x-api-key` (or a Bearer
 * human) authenticates identically. All the work is in `dispatchMcpRequest`; the wiring is
 * in `McpDependencyFactory`, built once per execution environment and reused across warm
 * invocations.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { McpDependencyFactory, type McpDependencies } from '../dependencies/index.js';
import { dispatchMcpRequest } from '../mcp/dispatch.js';
import type { McpServerDeps } from '../mcp/server.js';
import { getLogger } from '../utils/logger.js';
import { getMcpConfig } from './mcp-config.js';

const logger = getLogger('mcp-lambda');

let deps: McpDependencies | undefined;

function init(): McpDependencies {
  if (deps) {
    logger.debug('Reusing lambda instance.');
    return deps;
  }
  logger.info('Creating new MCP handler instance.');
  deps = new McpDependencyFactory(getMcpConfig()).build();
  return deps;
}

export const handler = (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const { emailService, readService, inboundEnabled } = init();
  const serverDeps: McpServerDeps = {
    emailService,
    inboundEnabled,
    ...(readService ? { readService } : {}),
  };
  return dispatchMcpRequest(event, serverDeps);
};
