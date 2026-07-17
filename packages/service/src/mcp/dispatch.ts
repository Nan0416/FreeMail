/**
 * Orchestrates one stateless MCP request: authorize (from the authorizer context
 * only), build a fresh server + web-standard transport, hand the request through,
 * and translate the response back. Stateless mode (`sessionIdGenerator: undefined`
 * + `enableJsonResponse: true`) = each invocation is independent request/response
 * JSON, which is exactly the Lambda model — no sessions, no SSE.
 *
 * A fresh server + transport per invocation is required (the SDK expects one
 * transport per connection); both are closed in `finally`.
 *
 * The `EmailService` is injected so this whole path is testable with a fake service
 * and no AWS.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthError } from '../auth/errors.js';
import type { EmailService } from '../email/service.js';
import { subjectFromContext } from '../handlers/request-context.js';
import { eventToRequest, responseToResult } from './http-adapter.js';
import { buildMcpServer } from './server.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function dispatchMcpRequest(
  event: APIGatewayProxyEventV2,
  emailService: EmailService,
): Promise<APIGatewayProxyStructuredResultV2> {
  // The route sits behind the dual-scheme authorizer, which resolves an x-api-key
  // (or Bearer) to the owner subject. Reading it here is defense-in-depth — fail
  // closed if that wiring ever regresses — and documents that the caller's identity
  // comes ONLY from the authorizer context, never from tool input.
  try {
    subjectFromContext(event);
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        statusCode: error.status,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: error.code, message: error.message }),
      };
    }
    throw error;
  }

  const server = buildMcpServer(emailService);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(eventToRequest(event));
    return await responseToResult(response);
  } catch (error) {
    console.error('MCP dispatch: unexpected transport failure', error);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: 'invalid_request', message: 'Internal error.' }),
    };
  } finally {
    // Closing the server closes its connected transport.
    await server.close();
  }
}
