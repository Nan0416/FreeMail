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
 * The service deps are injected so this whole path is testable with fakes and no AWS.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthError, authErrors } from '../auth/errors.js';
import { subjectFromContext } from '../handlers/request-context.js';
import { hasJsonContentType } from '../handlers/content-type.js';
import { eventToRequest, responseToResult } from './http-adapter.js';
import { buildMcpServer, type McpServerDeps } from './server.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function dispatchMcpRequest(
  event: APIGatewayProxyEventV2,
  deps: McpServerDeps,
): Promise<APIGatewayProxyStructuredResultV2> {
  // The route sits behind the dual-scheme authorizer, which resolves an x-api-key
  // (or Bearer) to the owner subject. Reading it here is defense-in-depth — fail
  // closed if that wiring ever regresses — and documents that the caller's identity
  // comes ONLY from the authorizer context, never from tool input.
  // #47 Layer 3: POST /mcp is a cookie-reachable state-changing route, so it must be a
  // NON-SIMPLE request — a same-site sibling must not be able to form-POST it. JSON-RPC
  // is JSON by definition, so every real MCP client already sends this; a no-`Origin`
  // agent call with `x-api-key` is unaffected. Checked before the server/transport is
  // built so nothing runs on a wrongly-shaped request.
  if (!hasJsonContentType(event.headers)) {
    const error = authErrors.unsupportedMediaType();
    return Promise.resolve({
      statusCode: error.status,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: error.code, message: error.message }),
    });
  }

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

  const server = buildMcpServer(deps);
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
