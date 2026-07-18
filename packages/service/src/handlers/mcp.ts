/**
 * MCP server Lambda. A separate handler from the REST API (`rest.ts`) but on the
 * SAME HTTP API behind the SAME dual-scheme authorizer (#5) — so an agent's
 * `x-api-key` (or a Bearer human) authenticates identically. `send_email` is a thin
 * wrapper over the shared {@link EmailService}; the read tools (`list_emails` /
 * `get_email` / `get_email_attachment_url`, #13) are thin wrappers over the shared
 * {@link EmailReadService} and are registered only when inbound is enabled. All the
 * work is in `dispatchMcpRequest`, so this file is just env wiring.
 *
 * Inbound-gate: the read tools are the agent surface for reading INBOUND mail, so
 * they're only built when `INBOUND_ENABLED` is exactly `'true'` (fail-closed). When
 * off, the read service isn't constructed (the Lambda has no read grants), and only
 * `send_email` is advertised.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createEmailServiceFromEnv } from '../email/create-email-service.js';
import { createEmailReadServiceFromEnv } from '../email/create-read-service.js';
import { dispatchMcpRequest } from '../mcp/dispatch.js';
import type { McpServerDeps } from '../mcp/server.js';

export const handler = (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const inboundEnabled = process.env.INBOUND_ENABLED === 'true';
  const deps: McpServerDeps = {
    emailService: createEmailServiceFromEnv(),
    inboundEnabled,
    ...(inboundEnabled ? { readService: createEmailReadServiceFromEnv() } : {}),
  };
  return dispatchMcpRequest(event, deps);
};
