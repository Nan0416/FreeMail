import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
