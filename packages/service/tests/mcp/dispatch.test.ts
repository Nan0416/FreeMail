import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import type { EmailReadService } from '../../src/services/email-read-service.js';
import type { EmailService } from '../../src/services/email-service.js';
import { dispatchMcpRequest } from '../../src/mcp/dispatch.js';

const AUTHORIZED_CONTEXT = { lambda: { sub: 'owner-subject', scheme: 'apiKey' } };

function makeEvent(
  body: string,
  authorizer: Record<string, unknown> | undefined,
  contentType: string | null = 'application/json',
): APIGatewayProxyEventV2 {
  return {
    headers: {
      ...(contentType === null ? {} : { 'content-type': contentType }),
      accept: 'application/json, text/event-stream',
    },
    rawPath: '/mcp',
    rawQueryString: '',
    isBase64Encoded: false,
    body,
    requestContext: { http: { method: 'POST' }, domainName: 'api.example.com', authorizer },
  } as unknown as APIGatewayProxyEventV2;
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

describe('dispatchMcpRequest — #47 Layer 3 media-type gate', () => {
  it('rejects a non-JSON content type with 415 before building the server', async () => {
    const send = vi.fn();
    const result = await dispatchMcpRequest(
      makeEvent(initializeBody(), AUTHORIZED_CONTEXT, 'text/plain'),
      { emailService: { send } as unknown as EmailService, inboundEnabled: false },
    );

    expect(result.statusCode).toBe(415);
    expect(JSON.parse(result.body ?? '{}')).toMatchObject({ error: 'unsupported_media_type' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an absent content type', async () => {
    const result = await dispatchMcpRequest(makeEvent(initializeBody(), AUTHORIZED_CONTEXT, null), {
      emailService: { send: vi.fn() } as unknown as EmailService,
      inboundEnabled: false,
    });
    expect(result.statusCode).toBe(415);
  });

  it('leaves the no-Origin agent path untouched: x-api-key + JSON still succeeds', async () => {
    // The invariant the whole CORS design rests on — CORS governs browsers, and an agent
    // call carries no Origin at all. The gate is a request-SHAPE rule, not an origin
    // check, so this must behave exactly as before #47.
    const event = makeEvent(initializeBody(), AUTHORIZED_CONTEXT);
    expect(event.headers?.origin).toBeUndefined();

    const result = await dispatchMcpRequest(event, {
      emailService: { send: vi.fn() } as unknown as EmailService,
      inboundEnabled: false,
    });
    expect(result.statusCode).toBe(200);
  });
});

describe('dispatchMcpRequest', () => {
  it('fails closed with 401 when the authorizer context is missing (never reaching send)', async () => {
    const send = vi.fn();
    const emailService = { send } as unknown as EmailService;

    const result = await dispatchMcpRequest(makeEvent(initializeBody(), undefined), {
      emailService,
      inboundEnabled: false,
    });

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body ?? '{}')).toMatchObject({ error: 'invalid_token' });
    expect(send).not.toHaveBeenCalled();
  });

  it('handles an initialize request end-to-end when authorized', async () => {
    const send = vi.fn();
    const emailService = { send } as unknown as EmailService;

    const result = await dispatchMcpRequest(makeEvent(initializeBody(), AUTHORIZED_CONTEXT), {
      emailService,
      inboundEnabled: false,
    });

    expect(result.statusCode).toBe(200);
    expect(String(result.headers?.['content-type'])).toContain('application/json');
    const payload = JSON.parse(result.body ?? '{}');
    expect(payload.result.serverInfo.name).toBe('freemail');
    expect(payload.result.capabilities.tools).toBeDefined();
    // initialize does not invoke the tool.
    expect(send).not.toHaveBeenCalled();
  });

  it('runs a send_email tools/call end-to-end over the HTTP path', async () => {
    const send = vi.fn().mockResolvedValue({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    const emailService = { send } as unknown as EmailService;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'send_email',
        arguments: { from: 'me@example.com', to: ['you@elsewhere.com'], text: 'hi' },
      },
    });

    const result = await dispatchMcpRequest(makeEvent(body, AUTHORIZED_CONTEXT), {
      emailService,
      inboundEnabled: false,
    });

    expect(result.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith({
      from: 'me@example.com',
      to: ['you@elsewhere.com'],
      text: 'hi',
    });
    const payload = JSON.parse(result.body ?? '{}');
    expect(payload.result.structuredContent).toEqual({
      id: 'email-1',
      messageId: 'ses-1',
      sentAt: '2026-07-17T00:00:00.000Z',
    });
    expect(payload.result.isError).toBeFalsy();
  });

  it('runs a list_emails tools/call end-to-end when inbound is enabled', async () => {
    const listEmails = vi.fn().mockResolvedValue({ emails: [] });
    const readService = { listEmails } as unknown as EmailReadService;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_emails', arguments: { limit: 10 } },
    });

    const result = await dispatchMcpRequest(makeEvent(body, AUTHORIZED_CONTEXT), {
      emailService: { send: vi.fn() } as unknown as EmailService,
      readService,
      inboundEnabled: true,
    });

    expect(result.statusCode).toBe(200);
    expect(listEmails).toHaveBeenCalledWith({ limit: 10 });
    const payload = JSON.parse(result.body ?? '{}');
    expect(payload.result.structuredContent.trust).toBe('self_authored_content');
    expect(payload.result.isError).toBeFalsy();
  });
});
