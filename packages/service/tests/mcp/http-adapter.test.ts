import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { eventToRequest, responseToResult } from '../../src/mcp/http-adapter.js';

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    headers: { 'content-type': 'application/json' },
    rawPath: '/mcp',
    rawQueryString: '',
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST' }, domainName: 'api.example.com' },
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

describe('eventToRequest', () => {
  it('reconstructs method, url, headers, and a plain body', async () => {
    const request = eventToRequest(
      makeEvent({
        headers: { 'content-type': 'application/json', host: 'api.example.com' },
        body: '{"jsonrpc":"2.0"}',
      }),
    );

    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/mcp');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
  });

  it('decodes a base64-encoded body', async () => {
    const json = '{"jsonrpc":"2.0","method":"initialize"}';
    const request = eventToRequest(
      makeEvent({ body: Buffer.from(json, 'utf8').toString('base64'), isBase64Encoded: true }),
    );

    expect(await request.text()).toBe(json);
  });

  it('carries no body for GET', async () => {
    const request = eventToRequest(
      makeEvent({
        requestContext: { http: { method: 'GET' }, domainName: 'api.example.com' } as never,
      }),
    );

    expect(request.method).toBe('GET');
    expect(await request.text()).toBe('');
  });

  it('falls back to the request-context domain when no host header is present', () => {
    const request = eventToRequest(makeEvent({ headers: {} }));
    expect(new URL(request.url).host).toBe('api.example.com');
  });
});

describe('responseToResult', () => {
  it('preserves status, content-type, and body', async () => {
    const result = await responseToResult(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-type']).toBe('application/json');
    expect(result.body).toBe('{"ok":true}');
  });

  it('preserves a non-200 status and omits an empty body', async () => {
    const result = await responseToResult(
      new Response(null, { status: 202, headers: { 'content-type': 'text/plain' } }),
    );

    expect(result.statusCode).toBe(202);
    expect(result.headers?.['content-type']).toBe('text/plain');
    expect(result.body).toBeUndefined();
  });
});
