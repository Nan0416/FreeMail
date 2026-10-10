import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailErrors } from '../../src/utils/errors.js';
import { authErrors } from '../../src/utils/errors.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../src/utils/cookies.js';
import { JSON_REQUIRED_ROUTES } from '../../src/middleware/json-content-type.js';
import { handler } from '../../src/handlers/service-handler.js';

// Stub AuthService so the auth-cookie routes exercise the handler's set/clear/no-store
// plumbing without DDB. OWNER_SUBJECT is re-exported because the handler imports it.
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../../src/services/auth-service.js', () => ({
  OWNER_SUBJECT: 'owner',
  AuthService: class {
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

// The handler builds an AuthService (which reads the signing key) for the auth routes;
// stub it so these tests exercise routing/authorization without AWS. The key routes reject
// the api-key scheme BEFORE any table access, so no DDB is touched.
vi.mock('../../src/utils/signing-key.js', () => ({
  getSigningKey: () => Promise.resolve('test-signing-key'),
  getOrCreateSigningKey: () => Promise.resolve('test-signing-key'),
  resetSigningKeyCache: () => {},
}));

// Stub the send service so /emails routing/authorization is exercised without SES.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/email-service.js', () => ({
  EmailService: class {
    send = sendMock;
  },
}));

// Stub the read service so the read routes exercise routing/authorization/validation
// without DDB or S3.
const readMocks = vi.hoisted(() => ({
  listEmails: vi.fn(),
  getEmail: vi.fn(),
  getAttachmentUrl: vi.fn(),
  getRawUrl: vi.fn(),
}));
vi.mock('../../src/services/email-read-service.js', () => ({
  EmailReadService: class {
    listEmails = readMocks.listEmails;
    getEmail = readMocks.getEmail;
    getAttachmentUrl = readMocks.getAttachmentUrl;
    getRawUrl = readMocks.getRawUrl;
  },
}));

// Stub the API-key service so routes that pass the auth/media-type gates exercise the
// router without DDB (the access-scheme tests below never reach it either way).
const keysMocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), revoke: vi.fn() }));
vi.mock('../../src/services/api-key-service.js', () => ({
  ApiKeyService: class {
    create = keysMocks.create;
    list = keysMocks.list;
    revoke = keysMocks.revoke;
  },
}));
vi.mock('../../src/data/ddb-api-keys-dao.js', () => ({ DdbApiKeysDao: class {} }));

// Stub the upload service so POST /attachments/uploads exercises routing/validation without S3.
const uploadMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/services/attachment-upload-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/attachment-upload-service.js')>()),
  AttachmentUploadService: class {
    create = uploadMock.create;
  },
}));

// Stub the download service so the public GET /d/{token} route exercises the
// redirect/uniform-404 plumbing without DDB or S3.
const downloadMock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../src/services/download-service.js', () => ({
  DownloadService: class {
    resolve = downloadMock.resolve;
  },
}));

/**
 * Every REST route, as the API Gateway `routeKey`s `ApiConstruct` registers, paired with
 * the path parameters needed to build a concrete request path. Driving the tests off this
 * table is what keeps the CDK route templates (`/emails/{id}`) and the Express route
 * patterns (`/emails/:id`) — two separate declarations in two syntaxes — from drifting.
 */
const ROUTES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['POST /auth/login', {}],
  ['POST /auth/refresh', {}],
  ['POST /auth/logout', {}],
  ['GET /me', {}],
  ['POST /keys', {}],
  ['GET /keys', {}],
  ['DELETE /keys/{id}', { id: 'key-1' }],
  ['POST /emails', {}],
  ['POST /attachments/uploads', {}],
  ['GET /emails', {}],
  ['GET /emails/{id}', { id: 'handle-123' }],
  ['GET /emails/{id}/attachments/{attachmentId}', { id: 'handle-1', attachmentId: '0' }],
  ['GET /emails/{id}/raw', { id: 'handle-1' }],
  ['GET /d/{token}', { token: 'tok-abc' }],
];

const DEFAULT_PARAMS = new Map(ROUTES);

/** Expand an API Gateway route template (`/emails/{id}`) into a concrete request path. */
function pathFor(routeKey: string, params: Record<string, string>): string {
  const template = routeKey.slice(routeKey.indexOf(' ') + 1);
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`No value supplied for path parameter "${name}" of ${routeKey}.`);
    }
    return encodeURIComponent(value);
  });
}

interface EventOptions {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  readonly cookies?: string[];
  /** `undefined` sends `application/json`; `null` omits the header entirely. */
  readonly contentType?: string | null;
  /** The authorizer's SIMPLE-response context; omitted entirely when absent. */
  readonly lambda?: Record<string, unknown>;
}

/** A payload-format-2.0 event, shaped exactly as API Gateway delivers one. */
function apiEvent(routeKey: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const method = routeKey.slice(0, routeKey.indexOf(' '));
  const path = pathFor(routeKey, options.params ?? DEFAULT_PARAMS.get(routeKey) ?? {});
  const headers: Record<string, string> = {};
  if (options.contentType !== null) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  return {
    version: '2.0',
    routeKey,
    rawPath: path,
    rawQueryString: options.query ? new URLSearchParams(options.query).toString() : '',
    headers,
    ...(options.cookies ? { cookies: options.cookies } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
      ...(options.lambda ? { authorizer: { lambda: options.lambda } } : {}),
    },
  } as unknown as APIGatewayProxyEventV2;
}

const LAMBDA_CONTEXT = { callbackWaitsForEmptyEventLoop: false } as unknown as Context;

function invoke(routeKey: string, options: EventOptions = {}) {
  return handler(apiEvent(routeKey, options), LAMBDA_CONTEXT);
}

/** The authorizer context for a given credential scheme (`undefined` = authed, no scheme). */
function lambdaContext(scheme: string | undefined): Record<string, unknown> {
  return scheme === undefined ? { sub: 'owner' } : { sub: 'owner', scheme };
}

beforeEach(() => {
  process.env.AUTH_TABLE = 'auth-test';
  process.env.API_KEYS_TABLE = 'keys-test';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.EMAILS_TABLE = 'emails-test';
  process.env.MAIL_BUCKET = 'mail-test';
  process.env.QUARANTINE_BUCKET = 'quarantine-test';
  process.env.DOWNLOAD_TOKENS_TABLE = 'tokens-test';
  process.env.DOWNLOAD_BASE_URL = 'https://api.test';
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    id: 'id-1',
    messageId: 'ses-1',
    sentAt: '2026-07-17T00:00:00.000Z',
  });
  authMocks.login.mockReset().mockResolvedValue(TOKEN_PAIR);
  authMocks.refresh.mockReset();
  authMocks.logout.mockReset().mockResolvedValue(undefined);
  downloadMock.resolve.mockReset();
});

afterEach(() => {
  delete process.env.AUTH_TABLE;
  delete process.env.API_KEYS_TABLE;
  delete process.env.EMAIL_DOMAIN;
  delete process.env.EMAILS_TABLE;
  delete process.env.MAIL_BUCKET;
  delete process.env.QUARANTINE_BUCKET;
  delete process.env.DOWNLOAD_TOKENS_TABLE;
  delete process.env.DOWNLOAD_BASE_URL;
});

describe('rest handler — the Express routes match the CDK route table', () => {
  // Two declarations of the same table, in two syntaxes (`{id}` vs `:id`). Anything that
  // reaches the terminal 404 handler is a route API Gateway would forward and Express
  // would drop.
  it.each(ROUTES.map(([routeKey]) => routeKey))(
    'routes %s to a handler, not the 404',
    async (routeKey) => {
      keysMocks.create.mockResolvedValue({ id: 'k', name: null, createdAt: 'now', key: 'raw' });
      keysMocks.list.mockResolvedValue({ keys: [] });
      keysMocks.revoke.mockResolvedValue(undefined);
      readMocks.listEmails.mockResolvedValue({ emails: [] });
      readMocks.getEmail.mockResolvedValue({ id: 'h', direction: 'inbound' });
      readMocks.getAttachmentUrl.mockResolvedValue({ url: 'u', expiresAt: 't' });
      readMocks.getRawUrl.mockResolvedValue({ url: 'u', expiresAt: 't' });
      downloadMock.resolve.mockResolvedValue(null);
      authMocks.refresh.mockResolvedValue(TOKEN_PAIR);

      const res = await invoke(routeKey, {
        lambda: lambdaContext('access'),
        body:
          routeKey === 'POST /auth/login' ? { password: 'a-password' } : { from: 'me@example.com' },
        cookies: [`${REFRESH_COOKIE}=RT`],
      });

      expect(reachedTerminal404(res)).toBe(false);
    },
  );
});

/**
 * True when a response came from `notFoundHandler` — i.e. Express matched no route. Checked
 * structurally rather than by status alone, because `GET /d/{token}` legitimately answers
 * 404 (with an HTML page) for an unusable token.
 */
function reachedTerminal404(res: APIGatewayProxyStructuredResultV2): boolean {
  return (
    res.statusCode === 404 &&
    (res.headers?.['content-type'] as string | undefined)?.includes('application/json') === true &&
    res.body === JSON.stringify({ error: 'invalid_request', message: 'Not found.' })
  );
}

describe('rest handler — key-management is access-token-only', () => {
  it.each(['POST /keys', 'GET /keys', 'DELETE /keys/{id}'])(
    'rejects an x-api-key credential on %s with 403 forbidden',
    async (routeKey) => {
      const res = await invoke(routeKey, { lambda: lambdaContext('apiKey') });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
    },
  );

  it('also rejects a missing scheme (fails closed)', async () => {
    const res = await invoke('POST /keys', { lambda: lambdaContext(undefined) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
  });

  it('also rejects a request with no authorizer context at all (fails closed)', async () => {
    const res = await invoke('POST /keys');
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
  });
});

describe('rest handler — send email is dual-scheme', () => {
  it.each(['access', 'apiKey'])(
    'lets a %s credential send (no access-only guard)',
    async (scheme) => {
      const res = await invoke('POST /emails', {
        lambda: lambdaContext(scheme),
        body: { from: 'me@example.com', to: ['x@y.com'], text: 'hi' },
      });
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

describe('rest handler — attachment uploads are dual-scheme', () => {
  it.each(['access', 'apiKey'])('lets a %s credential create an upload', async (scheme) => {
    uploadMock.create.mockReset().mockResolvedValue({
      uploadId: 'u1',
      uploadUrl: 'https://s3/u1',
      uploadMethod: 'PUT',
      expiresAt: 't',
    });
    const res = await invoke('POST /attachments/uploads', {
      lambda: lambdaContext(scheme),
      body: { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 12 },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ uploadId: 'u1', uploadMethod: 'PUT' });
    expect(uploadMock.create).toHaveBeenCalledWith({
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12,
    });
  });

  it('rejects a non-numeric size with 400 before reaching the service', async () => {
    uploadMock.create.mockReset();
    const res = await invoke('POST /attachments/uploads', {
      lambda: lambdaContext('access'),
      body: { filename: 'a.pdf', sizeBytes: '12' },
    });
    expect(res.statusCode).toBe(400);
    expect(uploadMock.create).not.toHaveBeenCalled();
  });
});

describe('rest handler — reads are access-token-only', () => {
  beforeEach(() => {
    readMocks.listEmails.mockReset().mockResolvedValue({ emails: [] });
    readMocks.getEmail.mockReset().mockResolvedValue({ id: 'h', direction: 'inbound' });
    readMocks.getAttachmentUrl.mockReset().mockResolvedValue({ url: 'u', expiresAt: 't' });
    readMocks.getRawUrl.mockReset().mockResolvedValue({ url: 'u', expiresAt: 't' });
  });

  it.each([
    'GET /emails',
    'GET /emails/{id}',
    'GET /emails/{id}/attachments/{attachmentId}',
    'GET /emails/{id}/raw',
  ])('rejects an x-api-key credential on %s with 403 forbidden', async (routeKey) => {
    const res = await invoke(routeKey, { contentType: null, lambda: lambdaContext('apiKey') });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
  });

  it('rejects a missing scheme on reads (fails closed)', async () => {
    const res = await invoke('GET /emails', {
      contentType: null,
      lambda: lambdaContext(undefined),
    });
    expect(res.statusCode).toBe(403);
    expect(readMocks.listEmails).not.toHaveBeenCalled();
  });

  it('lists with a parsed, clamped query', async () => {
    const res = await invoke('GET /emails', {
      contentType: null,
      lambda: lambdaContext('access'),
      query: { direction: 'inbound', limit: '999', cursor: 'abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(readMocks.listEmails).toHaveBeenCalledWith({
      direction: 'inbound',
      limit: 100,
      cursor: 'abc',
    });
  });

  it('defaults the limit and omits absent filters', async () => {
    await invoke('GET /emails', { contentType: null, lambda: lambdaContext('access') });
    expect(readMocks.listEmails).toHaveBeenCalledWith({ limit: 25 });
  });

  it('rejects a bad direction / non-positive-integer limit with 400', async () => {
    for (const query of [
      { direction: 'bogus' },
      { limit: 'abc' },
      { limit: '0' },
      { limit: '-3' },
    ]) {
      const res = await invoke('GET /emails', {
        contentType: null,
        lambda: lambdaContext('access'),
        query,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(readMocks.listEmails).not.toHaveBeenCalled();
  });

  it('reads one message by its path id', async () => {
    await invoke('GET /emails/{id}', {
      contentType: null,
      lambda: lambdaContext('access'),
      params: { id: 'handle-123' },
    });
    expect(readMocks.getEmail).toHaveBeenCalledWith({ handle: 'handle-123' });
  });

  it('mints an attachment url from both path params', async () => {
    await invoke('GET /emails/{id}/attachments/{attachmentId}', {
      contentType: null,
      lambda: lambdaContext('access'),
      params: { id: 'handle-1', attachmentId: '0' },
    });
    expect(readMocks.getAttachmentUrl).toHaveBeenCalledWith({
      handle: 'handle-1',
      attachmentId: '0',
    });
  });

  it('mints a raw (.eml) url from the path id', async () => {
    const res = await invoke('GET /emails/{id}/raw', {
      contentType: null,
      lambda: lambdaContext('access'),
      params: { id: 'handle-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(readMocks.getRawUrl).toHaveBeenCalledWith({ handle: 'handle-1' });
    expect(readMocks.getEmail).not.toHaveBeenCalled();
  });

  it('maps a service not_found to a 404 body', async () => {
    readMocks.getEmail.mockRejectedValueOnce(emailErrors.notFound('No such message.'));
    const res = await invoke('GET /emails/{id}', {
      contentType: null,
      lambda: lambdaContext('access'),
      params: { id: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}').error).toBe('not_found');
  });
});

describe('rest handler — #47 Layer 3: state-changing routes require application/json', () => {
  // Driven off the exported set so the middleware's auditable list and the routes actually
  // wearing `requireJsonContentType` can never disagree.
  const gated = [...JSON_REQUIRED_ROUTES];

  it('gates exactly the documented six routes', () => {
    expect(gated.sort()).toEqual(
      [
        'POST /auth/login',
        'POST /auth/logout',
        'POST /auth/refresh',
        'POST /emails',
        'POST /keys',
        'POST /attachments/uploads',
      ].sort(),
    );
  });

  it.each(gated)(
    'rejects %s with 415 when the content type is a simple-request type',
    async (routeKey) => {
      const res = await invoke(routeKey, {
        contentType: 'application/x-www-form-urlencoded',
        lambda: lambdaContext('access'),
      });
      expect(res.statusCode).toBe(415);
      expect(JSON.parse(res.body ?? '{}').error).toBe('unsupported_media_type');
    },
  );

  it.each(gated)(
    'rejects %s with 415 when the content-type header is absent entirely',
    async (routeKey) => {
      const res = await invoke(routeKey, { contentType: null, lambda: lambdaContext('access') });
      expect(res.statusCode).toBe(415);
    },
  );

  it('rejects refresh BEFORE rotating or clearing any cookie', async () => {
    // The whole point of gating a bodyless cookie-only POST: a same-site sibling
    // form-POST must not be able to touch the session at all. A 415 that still cleared
    // the cookies would be a forced-logout DoS wearing an error code.
    const res = await invoke('POST /auth/refresh', {
      contentType: 'text/plain',
      cookies: [`${REFRESH_COOKIE}=RT`],
    });
    expect(res.statusCode).toBe(415);
    expect(res.cookies).toBeUndefined();
    expect(authMocks.refresh).not.toHaveBeenCalled();
  });

  it('rejects logout BEFORE revoking the refresh token', async () => {
    const res = await invoke('POST /auth/logout', {
      contentType: 'text/plain',
      cookies: [`${REFRESH_COOKIE}=RT`],
    });
    expect(res.statusCode).toBe(415);
    expect(res.cookies).toBeUndefined();
    expect(authMocks.logout).not.toHaveBeenCalled();
  });

  it('accepts a charset parameter on a gated route', async () => {
    authMocks.login.mockResolvedValue(TOKEN_PAIR);
    const res = await invoke('POST /auth/login', {
      body: { password: 'a-password' },
      contentType: 'application/json; charset=utf-8',
    });
    expect(res.statusCode).toBe(200);
  });

  it('does NOT gate DELETE — already non-simple by method, so a content-type rule is theater', async () => {
    keysMocks.revoke.mockResolvedValue(undefined);
    const res = await invoke('DELETE /keys/{id}', {
      contentType: null,
      lambda: lambdaContext('access'),
    });
    expect(res.statusCode).toBe(204);
    expect(keysMocks.revoke).toHaveBeenCalledWith({ keyId: 'key-1' });
  });

  it('does NOT gate reads', async () => {
    readMocks.listEmails.mockResolvedValue({ emails: [] });
    const res = await invoke('GET /emails', {
      contentType: null,
      lambda: lambdaContext('access'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('never parses a form-encoded body, even on an ungated route', async () => {
    // No `express.urlencoded()` is registered: parsing the one content type the gate
    // exists to refuse would be building the door we just locked.
    readMocks.listEmails.mockResolvedValue({ emails: [] });
    const res = await invoke('GET /emails', {
      contentType: 'application/x-www-form-urlencoded',
      lambda: lambdaContext('access'),
    });
    expect(res.statusCode).toBe(200);
    expect(readMocks.listEmails).toHaveBeenCalled();
  });
});

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
    const res = await invoke('POST /auth/login', { body: { password: 'a-password' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ subject: 'owner' });
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.cookies?.[0]).toContain(`${ACCESS_COOKIE}=AT`);
    expect(res.cookies?.[1]).toContain(`${REFRESH_COOKIE}=RT`);
    expect(authMocks.login).toHaveBeenCalledWith({ password: 'a-password' });
  });

  it('does not advertise the framework', async () => {
    const res = await invoke('POST /auth/login', { body: { password: 'a-password' } });
    expect(res.headers?.['x-powered-by']).toBeUndefined();
  });
});

describe('rest handler — refresh reads the cookie only, clears on every failure', () => {
  it('rotates from the refresh cookie and sets fresh cookies (204, no-store)', async () => {
    authMocks.refresh.mockResolvedValue({ ...TOKEN_PAIR, accessToken: 'AT2', refreshToken: 'RT2' });
    const res = await invoke('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=RT`] });
    expect(res.statusCode).toBe(204);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.refresh).toHaveBeenCalledWith({ refreshToken: 'RT' });
    expect(res.cookies?.[0]).toContain(`${ACCESS_COOKIE}=AT2`);
    expect(res.cookies?.[1]).toContain(`${REFRESH_COOKIE}=RT2`);
  });

  it('rejects + clears both when the refresh cookie is absent (never touches the service)', async () => {
    const res = await invoke('POST /auth/refresh');
    expect(res.statusCode).toBe(401);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('NEVER reads the refresh token from the request body', async () => {
    const res = await invoke('POST /auth/refresh', { body: { refreshToken: 'FROM_BODY' } });
    expect(res.statusCode).toBe(401);
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('rejects + clears both on a duplicate/injected refresh cookie (without guessing)', async () => {
    // serverless-express joins the API Gateway v2 cookie ARRAY into one `Cookie:` header,
    // which is why the route reads the original event instead of `req.headers.cookie`:
    // after the join, a smuggled second copy is far harder to tell from one legitimate one.
    const res = await invoke('POST /auth/refresh', {
      cookies: [`${REFRESH_COOKIE}=a`, `${REFRESH_COOKIE}=b`],
    });
    expect(res.statusCode).toBe(401);
    expect(authMocks.refresh).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('clears both and emits NO refreshed credential on a malformed/expired/replayed token', async () => {
    authMocks.refresh.mockRejectedValue(authErrors.invalidToken());
    const res = await invoke('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=stale`] });
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await invoke('POST /auth/refresh', { cookies: [`${REFRESH_COOKIE}=${SECRET}`] });
      expect(res.statusCode).toBe(500);
      const logged = [errorSpy, logSpy, warnSpy]
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '))
        .join('\n');
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(REFRESH_COOKIE);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('rest handler — logout clears both cookies (POST, idempotent)', () => {
  it('revokes the presented refresh token and clears both (204, no-store)', async () => {
    const res = await invoke('POST /auth/logout', { cookies: [`${REFRESH_COOKIE}=RT`] });
    expect(res.statusCode).toBe(204);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(authMocks.logout).toHaveBeenCalledWith({ refreshToken: 'RT' });
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('still clears both with no cookie present (idempotent, no revoke)', async () => {
    const res = await invoke('POST /auth/logout');
    expect(res.statusCode).toBe(204);
    expect(authMocks.logout).not.toHaveBeenCalled();
    expect(allCleared(res.cookies)).toBe(true);
  });

  it('still clears both AND returns non-2xx when server-side revocation throws', async () => {
    authMocks.logout.mockRejectedValue(new Error('store unavailable'));
    const res = await invoke('POST /auth/logout', { cookies: [`${REFRESH_COOKIE}=RT`] });
    // Non-2xx so the client knows the revoke wasn't clean...
    expect(res.statusCode).toBe(500);
    expect(res.headers?.['cache-control']).toBe('no-store');
    // ...but the "always clear" contract still holds (best-effort remove the browser copy).
    expect(allCleared(res.cookies)).toBe(true);
  });
});

describe('rest handler — public token download (GET /d/{token})', () => {
  it('302-redirects a valid token to the presigned URL, no-store, no auth context needed', async () => {
    downloadMock.resolve.mockResolvedValue({ url: 'https://s3.example.com/signed-get' });
    const res = await invoke('GET /d/{token}', { contentType: null, params: { token: 'tok-abc' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers?.location).toBe('https://s3.example.com/signed-get');
    expect(res.headers?.['cache-control']).toBe('no-store');
    // No S3 key/bucket disclosed, and — unlike `res.redirect()` — no body echoing the
    // presigned URL either.
    expect(res.body).toBe('');
    expect(downloadMock.resolve).toHaveBeenCalledWith({ token: 'tok-abc' });
  });

  it('serves a uniform 404 HTML page for any invalid/expired/revoked/exhausted token', async () => {
    downloadMock.resolve.mockResolvedValue(null);
    const res = await invoke('GET /d/{token}', { contentType: null, params: { token: 'tok-bad' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers?.['content-type']).toContain('text/html');
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toContain('no longer available');
    // The failing token is never reflected into the page (no oracle, no reflected XSS).
    expect(res.body).not.toContain('tok-bad');
  });
});
