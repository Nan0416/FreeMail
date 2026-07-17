import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailErrors } from '../email/errors.js';
import { handler } from './rest.js';

// The handler builds an AuthService (which reads the signing key) for every route;
// stub it so these tests exercise routing/authorization without AWS. The key
// routes reject the api-key scheme BEFORE any table access, so no DDB is touched.
vi.mock('../config/signing-key.js', () => ({
  getSigningKey: () => Promise.resolve('test-signing-key'),
  resetSigningKeyCache: () => {},
}));

// Stub the send service so /emails routing/authorization is exercised without SES.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../email/service.js', () => ({
  EmailService: class {
    send = sendMock;
  },
}));

// Stub the read service so the read routes exercise routing/authorization/validation
// without DDB or S3.
const { readMocks } = vi.hoisted(() => ({
  readMocks: { listEmails: vi.fn(), getEmail: vi.fn(), getAttachmentUrl: vi.fn() },
}));
vi.mock('../email/create-read-service.js', () => ({
  createEmailReadServiceFromEnv: () => readMocks,
}));

function keysEvent(routeKey: string, scheme: string | undefined): APIGatewayProxyEventV2 {
  const lambda = scheme === undefined ? { sub: 'owner' } : { sub: 'owner', scheme };
  return {
    routeKey,
    requestContext: { authorizer: { lambda } },
  } as unknown as APIGatewayProxyEventV2;
}

function sendEvent(scheme: string | undefined): APIGatewayProxyEventV2 {
  const lambda = scheme === undefined ? { sub: 'owner' } : { sub: 'owner', scheme };
  return {
    routeKey: 'POST /emails',
    body: JSON.stringify({ from: 'me@example.com', to: ['x@y.com'], text: 'hi' }),
    requestContext: { authorizer: { lambda } },
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  process.env.AUTH_TABLE = 'auth-test';
  process.env.API_KEYS_TABLE = 'keys-test';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.EMAILS_TABLE = 'emails-test';
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    id: 'id-1',
    messageId: 'ses-1',
    sentAt: '2026-07-17T00:00:00.000Z',
  });
});

afterEach(() => {
  delete process.env.AUTH_TABLE;
  delete process.env.API_KEYS_TABLE;
  delete process.env.EMAIL_DOMAIN;
  delete process.env.EMAILS_TABLE;
});

describe('rest handler — key-management is access-token-only', () => {
  it.each(['POST /keys', 'GET /keys', 'DELETE /keys/{id}'])(
    'rejects an x-api-key credential on %s with 403 forbidden',
    async (routeKey) => {
      const res = await handler(keysEvent(routeKey, 'apiKey'));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
    },
  );

  it('also rejects a missing scheme (fails closed)', async () => {
    const res = await handler(keysEvent('POST /keys', undefined));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
  });
});

describe('rest handler — send email is dual-scheme', () => {
  it.each(['access', 'apiKey'])(
    'lets a %s credential send (no access-only guard)',
    async (scheme) => {
      const res = await handler(sendEvent(scheme));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body ?? '{}')).toMatchObject({ messageId: 'ses-1' });
      expect(sendMock).toHaveBeenCalledWith({
        from: 'me@example.com',
        to: ['x@y.com'],
        text: 'hi',
      });
    },
  );
});

function readEvent(
  routeKey: string,
  scheme: string | undefined,
  opts: { query?: Record<string, string>; path?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  const lambda = scheme === undefined ? { sub: 'owner' } : { sub: 'owner', scheme };
  return {
    routeKey,
    queryStringParameters: opts.query,
    pathParameters: opts.path,
    requestContext: { authorizer: { lambda } },
  } as unknown as APIGatewayProxyEventV2;
}

describe('rest handler — reads are access-token-only', () => {
  beforeEach(() => {
    readMocks.listEmails.mockReset().mockResolvedValue({ emails: [] });
    readMocks.getEmail.mockReset().mockResolvedValue({ id: 'h', direction: 'inbound' });
    readMocks.getAttachmentUrl.mockReset().mockResolvedValue({ url: 'u', expiresAt: 't' });
  });

  it.each(['GET /emails', 'GET /emails/{id}', 'GET /emails/{id}/attachments/{attachmentId}'])(
    'rejects an x-api-key credential on %s with 403 forbidden',
    async (routeKey) => {
      const res = await handler(
        readEvent(routeKey, 'apiKey', { path: { id: 'h', attachmentId: '0' } }),
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
    },
  );

  it('rejects a missing scheme on reads (fails closed)', async () => {
    const res = await handler(readEvent('GET /emails', undefined));
    expect(res.statusCode).toBe(403);
    expect(readMocks.listEmails).not.toHaveBeenCalled();
  });

  it('lists with a parsed, clamped query', async () => {
    const res = await handler(
      readEvent('GET /emails', 'access', {
        query: { direction: 'inbound', limit: '999', cursor: 'abc' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(readMocks.listEmails).toHaveBeenCalledWith({
      direction: 'inbound',
      limit: 100,
      cursor: 'abc',
    });
  });

  it('defaults the limit and omits absent filters', async () => {
    await handler(readEvent('GET /emails', 'access', {}));
    expect(readMocks.listEmails).toHaveBeenCalledWith({ limit: 25 });
  });

  it('rejects a bad direction / non-positive-integer limit with 400', async () => {
    for (const query of [
      { direction: 'bogus' },
      { limit: 'abc' },
      { limit: '0' },
      { limit: '-3' },
    ]) {
      const res = await handler(readEvent('GET /emails', 'access', { query }));
      expect(res.statusCode).toBe(400);
    }
    expect(readMocks.listEmails).not.toHaveBeenCalled();
  });

  it('reads one message by its path id', async () => {
    await handler(readEvent('GET /emails/{id}', 'access', { path: { id: 'handle-123' } }));
    expect(readMocks.getEmail).toHaveBeenCalledWith('handle-123');
  });

  it('mints an attachment url from both path params', async () => {
    await handler(
      readEvent('GET /emails/{id}/attachments/{attachmentId}', 'access', {
        path: { id: 'handle-1', attachmentId: '0' },
      }),
    );
    expect(readMocks.getAttachmentUrl).toHaveBeenCalledWith('handle-1', '0');
  });

  it('maps a service not_found to a 404 body', async () => {
    readMocks.getEmail.mockRejectedValueOnce(emailErrors.notFound('No such message.'));
    const res = await handler(readEvent('GET /emails/{id}', 'access', { path: { id: 'nope' } }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}').error).toBe('not_found');
  });
});
