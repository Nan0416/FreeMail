import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailErrors } from '../email/errors.js';
import { authErrors } from '../auth/errors.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/cookies.js';
import { handler } from './rest.js';

// Stub AuthService so the auth-cookie routes exercise the handler's set/clear/no-store
// plumbing without DDB. OWNER_SUBJECT is re-exported because the handler imports it.
const { authMocks } = vi.hoisted(() => ({
  authMocks: {
    setPassword: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}));
vi.mock('../auth/service.js', () => ({
  OWNER_SUBJECT: 'owner',
  AuthService: class {
    setPassword = authMocks.setPassword;
    login = authMocks.login;
    refresh = authMocks.refresh;
    logout = authMocks.logout;
  },
}));

const TOKEN_PAIR = {
  tokenType: 'Bearer' as const,
  accessToken: 'AT',
  refreshToken: 'RT',
  expiresIn: 900,
};

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
  authMocks.setPassword.mockReset().mockResolvedValue(undefined);
  authMocks.login.mockReset().mockResolvedValue(TOKEN_PAIR);
  authMocks.refresh.mockReset();
  authMocks.logout.mockReset().mockResolvedValue(undefined);
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

function authEvent(
  routeKey: string,
  opts: { body?: unknown; cookies?: string[] } = {},
): APIGatewayProxyEventV2 {
  return {
    routeKey,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cookies: opts.cookies,
    requestContext: {},
  } as unknown as APIGatewayProxyEventV2;
}

function allCleared(cookies: string[] | undefined): boolean {
  return (
    cookies !== undefined &&
    cookies.length === 2 &&
    cookies[0] === `${ACCESS_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` &&
    cookies[1] === `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

describe('rest handler — session cookies (login)', () => {
  it('sets both httpOnly session cookies + no-store and echoes the subject', async () => {
    const res = await handler(authEvent('POST /auth/login', { body: { password: 'a-password' } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ subject: 'owner' });
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.cookies?.[0]).toContain(`${ACCESS_COOKIE}=AT`);
    expect(res.cookies?.[1]).toContain(`${REFRESH_COOKIE}=RT`);
    expect(authMocks.login).toHaveBeenCalledWith('a-password');
  });

  it('set-password returns 204 no-store and sets NO cookies', async () => {
    const res = await handler(authEvent('POST /auth/set-password', { body: { password: 'a-pw' } }));
    expect(res.statusCode).toBe(204);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.cookies).toBeUndefined();
    expect(authMocks.setPassword).toHaveBeenCalledWith('a-pw');
  });
});

describe('rest handler — refresh reads the cookie only, clears on every failure', () => {
  it('rotates from the refresh cookie and sets fresh cookies (204, no-store)', async () => {
    authMocks.refresh.mockResolvedValue({ ...TOKEN_PAIR, accessToken: 'AT2', refreshToken: 'RT2' });
    const res = await handler(
      authEvent('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=RT`] }),
    );
    expect(res.statusCode).toBe(204);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.refresh).toHaveBeenCalledWith('RT');
    expect(res.cookies?.[0]).toContain(`${ACCESS_COOKIE}=AT2`);
    expect(res.cookies?.[1]).toContain(`${REFRESH_COOKIE}=RT2`);
  });

  it('rejects + clears both when the refresh cookie is absent (never touches the service)', async () => {
    const res = await handler(authEvent('POST /auth/refresh', {}));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('NEVER reads the refresh token from the request body', async () => {
    const res = await handler(
      authEvent('POST /auth/refresh', { body: { refreshToken: 'FROM_BODY' } }),
    );
    expect(res.statusCode).toBe(401);
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('rejects + clears both on a duplicate/injected refresh cookie (without guessing)', async () => {
    const res = await handler(
      authEvent('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=a`, `${REFRESH_COOKIE}=b`] }),
    );
    expect(res.statusCode).toBe(401);
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('clears both and emits NO refreshed credential on a malformed/expired/replayed token', async () => {
    authMocks.refresh.mockRejectedValue(authErrors.invalidToken());
    const res = await handler(
      authEvent('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=stale`] }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers?.['cache-control']).toBe('no-store');
    // Both cookies are cleared (empty value, Max-Age=0) — never a fresh token.
    expect(allCleared(res.cookies)).toBe(true);
  });
});

describe('rest handler — never logs the Cookie header', () => {
  it('does not leak cookie values into logs on the unhandled-error path', async () => {
    const SECRET = 'super-secret-refresh-token-value';
    // Force the generic (non-AuthError) error path, which is the only place the
    // handler logs — it must log the error, never the request/cookies.
    authMocks.refresh.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await handler(
        authEvent('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=${SECRET}`] }),
      );
      expect(res.statusCode).toBe(500);
      const logged = errorSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(REFRESH_COOKIE);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('rest handler — logout clears both cookies (POST, idempotent)', () => {
  it('revokes the presented refresh token and clears both (204, no-store)', async () => {
    const res = await handler(
      authEvent('POST /auth/logout', { cookies: [`${REFRESH_COOKIE}=RT`] }),
    );
    expect(res.statusCode).toBe(204);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.logout).toHaveBeenCalledWith('RT');
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('still clears both with no cookie present (idempotent, no revoke)', async () => {
    const res = await handler(authEvent('POST /auth/logout', {}));
    expect(res.statusCode).toBe(204);
    expect(authMocks.logout).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('still clears both AND returns non-2xx when server-side revocation throws', async () => {
    authMocks.logout.mockRejectedValue(new Error('store unavailable'));
    const res = await handler(
      authEvent('POST /auth/logout', { cookies: [`${REFRESH_COOKIE}=RT`] }),
    );
    // Non-2xx so the client knows the revoke wasn't clean...
    expect(res.statusCode).toBe(500);
    expect(res.headers?.['cache-control']).toBe('no-store');
    // ...but the "always clear" contract still holds (best-effort remove the browser copy).
    expect(allCleared(res.cookies)).toBe(true);
  });
});
