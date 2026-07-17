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

function keysEvent(routeKey: string, scheme: string | undefined): APIGatewayProxyEventV2 {
  const lambda = scheme === undefined ? { sub: 'owner' } : { sub: 'owner', scheme };
  return {
    routeKey,
    requestContext: { authorizer: { lambda } },
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  process.env.AUTH_TABLE = 'auth-test';
  process.env.API_KEYS_TABLE = 'keys-test';
});

afterEach(() => {
  delete process.env.AUTH_TABLE;
  delete process.env.API_KEYS_TABLE;
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
