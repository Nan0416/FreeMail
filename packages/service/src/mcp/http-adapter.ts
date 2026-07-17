/**
 * Adapters between API Gateway's (HTTP API, payload v2) Lambda event/result and the
 * web-standard Fetch `Request`/`Response` the MCP `WebStandardStreamableHTTPServerTransport`
 * speaks. Node 22 provides `Request`/`Response`/`Headers` as globals, so no shim of
 * a fake Node `IncomingMessage`/`ServerResponse` is needed — the transport is fed a
 * real `Request` and yields a real `Response`.
 *
 * Kept pure (no AWS, no transport) so the request-body decoding (incl. base64) and
 * the response status/header/body translation are unit-testable in isolation.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** Reconstruct a Fetch `Request` from the Lambda event, preserving method, headers, and body. */
export function eventToRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const host = headers.get('host') ?? event.requestContext.domainName ?? 'localhost';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `https://${host}${event.rawPath}${query}`;

  const init: RequestInit = { method, headers };
  // GET/HEAD carry no body; MCP tool-calling is POST. Honor isBase64Encoded — API
  // Gateway may base64 the body — decoding to UTF-8 (MCP is JSON) before handing it on.
  if (method !== 'GET' && method !== 'HEAD' && event.body !== undefined) {
    init.body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
  }

  return new Request(url, init);
}

/** Translate a Fetch `Response` back to an API Gateway result, preserving status + headers. */
export async function responseToResult(
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const body = await response.text();
  const result: APIGatewayProxyStructuredResultV2 = { statusCode: response.status, headers };
  if (body.length > 0) {
    result.body = body;
  }
  return result;
}
