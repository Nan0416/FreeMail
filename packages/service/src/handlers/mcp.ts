/**
 * MCP server Lambda. A separate handler from the REST API (`rest.ts`) but on the
 * SAME HTTP API behind the SAME dual-scheme authorizer (#5) — so an agent's
 * `x-api-key` (or a Bearer human) authenticates identically. The `send_email` tool
 * is a thin wrapper over the shared {@link EmailService}; all the work is in
 * `dispatchMcpRequest`, so this file is just env wiring.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createEmailServiceFromEnv } from '../email/create-email-service.js';
import { dispatchMcpRequest } from '../mcp/dispatch.js';

export const handler = (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> =>
  dispatchMcpRequest(event, createEmailServiceFromEnv());
