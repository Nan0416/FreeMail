/**
 * The MCP Lambda, driven end-to-end through real API Gateway (payload v2) events.
 *
 * This replaces the old `tests/mcp/dispatch.test.ts`. It is deliberately a HANDLER test
 * rather than a unit test of a dispatch function: the whole point of #53's port is that the
 * event-to-Express-to-transport conversion is now library code (serverless-express, and the
 * SDK's own `@hono/node-server` wrapper), so the only way to know it works is to feed the
 * real event shape in at the top and assert the real API Gateway result at the bottom.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The dependency factory builds the real services; stub them so routing, the guards, and
// the MCP protocol path are exercised without DDB, S3, or SES.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/email-service.js', () => ({
  EmailService: class {
    sendEmail = sendMock;
  },
}));

const readMocks = vi.hoisted(() => ({
  listEmails: vi.fn(),
  getEmail: vi.fn(),
  getAttachmentUrl: vi.fn(),
}));
vi.mock('../../src/services/email-read-service.js', () => ({
  EmailReadService: class {
    listEmails = readMocks.listEmails;
    getEmail = readMocks.getEmail;
    getAttachmentUrl = readMocks.getAttachmentUrl;
  },
}));

const LAMBDA_CONTEXT = { callbackWaitsForEmptyEventLoop: false } as unknown as Context;

/** The authorizer's SIMPLE-response context for an authenticated agent. */
const AUTHORIZED = { sub: 'owner-subject', scheme: 'apiKey' };

interface EventOptions {
  /** `undefined` sends `application/json`; `null` omits the header entirely. */
  readonly contentType?: string | null;
  /** The authorizer's context; omitted entirely when absent, as an unauthorized call is. */
  readonly lambda?: Record<string, unknown>;
  readonly accept?: string;
  /** `null` omits `host` — see the host-header test for why that is worth pinning. */
  readonly host?: string | null;
}

/** A payload-format-2.0 event for `POST /mcp`, shaped exactly as API Gateway delivers one. */
function apiEvent(body: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/json, text/event-stream',
  };
  // API Gateway always sends `host` — it is how a custom domain routes at all — and the SDK
  // transport REQUIRES it. See the host-header test below.
  if (options.host !== null) {
    headers.host = options.host ?? 'api.example.com';
  }
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    rawQueryString: '',
    headers,
    body,
    isBase64Encoded: false,
    requestContext: {
      domainName: 'api.example.com',
      http: { method: 'POST', path: '/mcp', protocol: 'HTTP/1.1', sourceIp: '203.0.113.1' },
      ...(options.lambda ? { authorizer: { lambda: options.lambda } } : {}),
    },
  } as unknown as APIGatewayProxyEventV2;
}

/**
 * The handler caches its Express app per execution environment, and `INBOUND_ENABLED` is
 * read once at cold start — so a test that needs the read tools must load a fresh module
 * graph. `vi.mock` registrations survive `resetModules`; the module-level app cache does not.
 */
async function loadHandler(inboundEnabled: boolean) {
  vi.resetModules();
  process.env.EMAILS_TABLE = 'emails-test';
  process.env.DOWNLOAD_TOKENS_TABLE = 'tokens-test';
  process.env.MAIL_BUCKET = 'mail-test';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.DOWNLOAD_BASE_URL = 'https://api.test';
  process.env.INBOUND_ENABLED = String(inboundEnabled);
  const module = await import('../../src/handlers/mcp.js');
  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
    module.handler(event, LAMBDA_CONTEXT);
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });
}

/** Just enough of the SDK's JSON-RPC response to assert on. */
interface JsonRpcResponse {
  readonly result?: {
    readonly serverInfo?: { readonly name: string };
    readonly capabilities?: { readonly tools?: unknown };
    readonly structuredContent?: Record<string, unknown>;
    readonly isError?: boolean;
    readonly tools?: readonly { readonly name: string }[];
  };
}

function payloadOf(result: APIGatewayProxyStructuredResultV2): Record<string, unknown> {
  return JSON.parse(result.body ?? '{}') as Record<string, unknown>;
}

/** The `result` member of a successful JSON-RPC response. */
function resultOf(result: APIGatewayProxyStructuredResultV2) {
  const payload = JSON.parse(result.body ?? '{}') as JsonRpcResponse;
  if (!payload.result) {
    throw new Error(`Expected a JSON-RPC result, got: ${result.body ?? '(no body)'}`);
  }
  return payload.result;
}

beforeEach(() => {
  sendMock.mockReset();
  readMocks.listEmails.mockReset();
});

describe('mcp handler — #47 Layer 3 media-type gate', () => {
  it('rejects a non-JSON content type with 415 before the tool can run', async () => {
    const handler = await loadHandler(false);
    const result = await handler(
      apiEvent(initializeBody(), { contentType: 'text/plain', lambda: AUTHORIZED }),
    );

    expect(result.statusCode).toBe(415);
    expect(payloadOf(result)).toMatchObject({ error: 'unsupported_media_type' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects an absent content type', async () => {
    const handler = await loadHandler(false);
    const result = await handler(
      apiEvent(initializeBody(), { contentType: null, lambda: AUTHORIZED }),
    );
    expect(result.statusCode).toBe(415);
  });

  it('leaves the no-Origin agent path untouched: x-api-key + JSON still succeeds', async () => {
    // The invariant the whole CORS design rests on — CORS governs browsers, and an agent
    // call carries no Origin at all. The gate is a request-SHAPE rule, not an origin
    // check, so this must behave exactly as before #47.
    const handler = await loadHandler(false);
    const event = apiEvent(initializeBody(), { lambda: AUTHORIZED });
    expect(event.headers?.origin).toBeUndefined();

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});

describe('mcp handler', () => {
  it('fails closed with 401 when the authorizer context is missing (never reaching send)', async () => {
    const handler = await loadHandler(false);
    const result = await handler(apiEvent(initializeBody()));

    expect(result.statusCode).toBe(401);
    expect(payloadOf(result)).toMatchObject({ error: 'invalid_token' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('handles an initialize request end-to-end when authorized', async () => {
    const handler = await loadHandler(false);
    const result = await handler(apiEvent(initializeBody(), { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(200);
    expect(String(result.headers?.['content-type'])).toContain('application/json');
    const payload = resultOf(result);
    expect(payload.serverInfo?.name).toBe('freemail');
    expect(payload.capabilities?.tools).toBeDefined();
    // initialize does not invoke the tool.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('runs a send_email tools/call end-to-end over the HTTP path', async () => {
    sendMock.mockResolvedValue({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    const handler = await loadHandler(false);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'send_email',
        arguments: { from: 'me@example.com', to: ['you@elsewhere.com'], text: 'hi' },
      },
    });

    const result = await handler(apiEvent(body, { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(200);
    expect(sendMock).toHaveBeenCalledWith({
      from: 'me@example.com',
      to: ['you@elsewhere.com'],
      text: 'hi',
    });
    const payload = resultOf(result);
    expect(payload.structuredContent).toEqual({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    expect(payload.isError).toBeFalsy();
  });

  it('runs a list_emails tools/call end-to-end when inbound is enabled', async () => {
    readMocks.listEmails.mockResolvedValue({ emails: [] });
    const handler = await loadHandler(true);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_emails', arguments: { limit: 10 } },
    });

    const result = await handler(apiEvent(body, { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(200);
    expect(readMocks.listEmails).toHaveBeenCalledWith({ limit: 10 });
    const payload = resultOf(result);
    expect(payload.structuredContent?.trust).toBe('self_authored_content');
    expect(payload.isError).toBeFalsy();
  });

  it('does not advertise the read tools when inbound is off', async () => {
    const handler = await loadHandler(false);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' });

    const result = await handler(apiEvent(body, { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(200);
    const names = resultOf(result).tools?.map((tool) => tool.name);
    expect(names).toEqual(['send_email', 'create_attachment_upload']);
  });

  it('returns the transport response headers, not a bare body (writeHead interop)', async () => {
    // REGRESSION GUARD. The SDK's Node transport delegates to `@hono/node-server`, which
    // sets every response header via `writeHead(status, headers)` and none via
    // `setHeader`. Express replaces `res`'s prototype with one descending from
    // `http.ServerResponse`, which cuts serverless-express's header-capturing `writeHead`
    // override out of the chain — so without `preserveWriteHeadHeaders` this result comes
    // back with `headers: {}` and an MCP client sees no content-type at all.
    const handler = await loadHandler(false);
    const result = await handler(apiEvent(initializeBody(), { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(200);
    expect(result.headers).toBeDefined();
    expect(String(result.headers?.['content-type'])).toContain('application/json');
    expect(Number(result.headers?.['content-length'])).toBeGreaterThan(0);
  });

  it('needs the host header API Gateway always sends', async () => {
    // DOCUMENTED DEPENDENCY, not a wish. The SDK transport builds a web `Request` via
    // `@hono/node-server`, which throws `RequestError('Missing host header')` without one
    // and answers with a bare, bodyless 400. The hand-written adapter this port replaced
    // fell back to `requestContext.domainName`; the library path has no such fallback.
    // API Gateway always sends `host` — it is how a custom domain routes at all — so this
    // pins the dependency rather than defending against it.
    const handler = await loadHandler(false);
    const result = await handler(apiEvent(initializeBody(), { lambda: AUTHORIZED, host: null }));

    expect(result.statusCode).toBe(400);
  });

  it('rejects a malformed JSON body at the body parser, in the service error shape', async () => {
    // A DELIBERATE consequence of handing the transport a pre-parsed body: `express.json()`
    // refuses the body first, so this is FreeMail's `{ error, message }` 400 rather than the
    // SDK's JSON-RPC `-32700`. Pinned here so the shape can only change on purpose.
    const handler = await loadHandler(false);
    const result = await handler(apiEvent('{"jsonrpc": ', { lambda: AUTHORIZED }));

    expect(result.statusCode).toBe(400);
    expect(payloadOf(result)).toMatchObject({ error: 'invalid_request' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
