import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
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
    sendEmail = sendMock;
  },
}));

// Stub the read service so the read routes exercise routing/authorization/validation
// without DDB or S3.
const readMocks = vi.hoisted(() => ({
  listEmails: vi.fn(),
  getEmail: vi.fn(),
  getAttachmentUrl: vi.fn(),
  getRawUrl: vi.fn(),
  getEmailWithDownloadUrls: vi.fn(),
}));
vi.mock('../../src/services/email-read-service.js', () => ({
  EmailReadService: class {
    listEmails = readMocks.listEmails;
    getEmail = readMocks.getEmail;
    getAttachmentUrl = readMocks.getAttachmentUrl;
    getRawUrl = readMocks.getRawUrl;
    getEmailWithDownloadUrls = readMocks.getEmailWithDownloadUrls;
  },
}));

// Stub the API-key service so routes that pass the auth/media-type gates exercise the
// router without DDB (the access-scheme tests below never reach it either way).
const keysMocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), revoke: vi.fn() }));
vi.mock('../../src/services/api-key-service.js', () => ({
  ApiKeyService: class {
    createApiKey = keysMocks.create;
    listApiKeys = keysMocks.list;
    revokeApiKey = keysMocks.revoke;
  },
}));
vi.mock('../../src/data/ddb-api-keys-dao.js', () => ({ DdbApiKeysDao: class {} }));

// Stub the forwarding-rule service: these tests cover routing, guards and body parsing; the
// service's own tests cover what a rule may contain.
const rulesMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../src/services/forwarding-rule-service.js', () => ({
  ForwardingRuleService: class {
    listForwardingRules = rulesMocks.list;
    createForwardingRule = rulesMocks.create;
    updateForwardingRule = rulesMocks.update;
    deleteForwardingRule = rulesMocks.remove;
  },
}));

// Stub the attachment service so POST /attachments/uploads and the public GET /d/{token}
// exercise routing/validation and the redirect/uniform-404 plumbing without DDB or S3.
const attachmentMocks = vi.hoisted(() => ({
  createAttachmentUpload: vi.fn(),
  resolveAttachmentDownloadPresignedUrl: vi.fn(),
}));
vi.mock('../../src/services/attachment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/attachment-service.js')>()),
  AttachmentService: class {
    createAttachmentUpload = attachmentMocks.createAttachmentUpload;
    resolveAttachmentDownloadPresignedUrl = attachmentMocks.resolveAttachmentDownloadPresignedUrl;
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
  ['GET /forwarding-rules', {}],
  ['POST /forwarding-rules', {}],
  ['PUT /forwarding-rules/{id}', { id: 'rule-1' }],
  ['DELETE /forwarding-rules/{id}', { id: 'rule-1' }],
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
  /** API Gateway's IAM context, for an IAM-authorized route. */
  readonly iam?: Record<string, unknown>;
  /** Overrides for a greedy route (`{proxy+}`), whose template has no concrete method or path. */
  readonly method?: string;
  readonly path?: string;
}

/** A payload-format-2.0 event, shaped exactly as API Gateway delivers one. */
function apiEvent(routeKey: string, options: EventOptions = {}): APIGatewayProxyEventV2 {
  const method = options.method ?? routeKey.slice(0, routeKey.indexOf(' '));
  const path = options.path ?? pathFor(routeKey, options.params ?? DEFAULT_PARAMS.get(routeKey) ?? {});
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
      ...(options.iam ? { authorizer: { iam: options.iam } } : {}),
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
  process.env.FORWARDING_RULES_TABLE = 'rules-test';
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
  attachmentMocks.resolveAttachmentDownloadPresignedUrl.mockReset();
});

afterEach(() => {
  delete process.env.AUTH_TABLE;
  delete process.env.API_KEYS_TABLE;
  delete process.env.FORWARDING_RULES_TABLE;
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
  it.each(ROUTES.map(([routeKey]) => routeKey))('routes %s to a handler, not the 404', async (routeKey) => {
    keysMocks.create.mockResolvedValue({ id: 'k', name: null, createdAt: 'now', key: 'raw' });
    keysMocks.list.mockResolvedValue({ keys: [] });
    keysMocks.revoke.mockResolvedValue(undefined);
    rulesMocks.list.mockResolvedValue({ rules: [] });
    rulesMocks.create.mockResolvedValue({ id: 'rule-1' });
    rulesMocks.update.mockResolvedValue({ id: 'rule-1' });
    rulesMocks.remove.mockResolvedValue(undefined);
    readMocks.listEmails.mockResolvedValue({ emails: [] });
    readMocks.getEmail.mockResolvedValue({ id: 'h', direction: 'inbound' });
    readMocks.getAttachmentUrl.mockResolvedValue({ url: 'u', expiresAt: 't' });
    readMocks.getRawUrl.mockResolvedValue({ url: 'u', expiresAt: 't' });
    attachmentMocks.resolveAttachmentDownloadPresignedUrl.mockResolvedValue(null);
    authMocks.refresh.mockResolvedValue(TOKEN_PAIR);

    const res = await invoke(routeKey, {
      lambda: lambdaContext('access'),
      body: routeKey === 'POST /auth/login' ? { password: 'a-password' } : { from: 'me@example.com' },
      cookies: [`${REFRESH_COOKIE}=RT`],
    });

    expect(reachedTerminal404(res)).toBe(false);
  });
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
  it.each(['POST /keys', 'GET /keys', 'DELETE /keys/{id}'])('rejects an x-api-key credential on %s with 403 forbidden', async (routeKey) => {
    const res = await invoke(routeKey, { lambda: lambdaContext('apiKey') });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
  });

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

describe('rest handler — forwarding rules are access-token-only', () => {
  // One rule can copy every received message to an outside address: an agent's API key must
  // never be able to add one.
  it.each(['GET /forwarding-rules', 'POST /forwarding-rules', 'PUT /forwarding-rules/{id}', 'DELETE /forwarding-rules/{id}'])(
    'rejects an x-api-key credential on %s with 403 forbidden',
    async (routeKey) => {
      const res = await invoke(routeKey, { lambda: lambdaContext('apiKey'), body: {} });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error).toBe('forbidden');
    },
  );

  it('also rejects a missing scheme, or no authorizer context (fails closed)', async () => {
    for (const lambda of [lambdaContext(undefined), undefined]) {
      const res = await invoke('POST /forwarding-rules', { lambda, body: {} });
      expect(res.statusCode).toBe(403);
    }
    expect(rulesMocks.create).not.toHaveBeenCalled();
  });
});

describe('rest handler — forwarding rules reach the service', () => {
  const FIELDS = {
    name: 'Vendor invoices',
    enabled: true,
    senderDomains: ['billing.example.com'],
    senderAddresses: [],
    recipientDomains: [],
    recipientAddresses: [],
    forwardTo: ['alex@example.com'],
    ignoreDmarcVerification: false,
  };

  beforeEach(() => {
    rulesMocks.list.mockReset();
    rulesMocks.create.mockReset();
    rulesMocks.update.mockReset();
    rulesMocks.remove.mockReset();
  });

  it('lists: GET /forwarding-rules → 200', async () => {
    rulesMocks.list.mockResolvedValue({ rules: [] });
    const res = await invoke('GET /forwarding-rules', {
      lambda: lambdaContext('access'),
      contentType: null,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ rules: [] });
    expect(rulesMocks.list).toHaveBeenCalledWith({});
  });

  it('creates: POST /forwarding-rules → 201 with the body’s fields', async () => {
    rulesMocks.create.mockResolvedValue({ ...FIELDS, id: 'rule-1' });
    const res = await invoke('POST /forwarding-rules', {
      lambda: lambdaContext('access'),
      body: FIELDS,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body ?? '{}').id).toBe('rule-1');
    expect(rulesMocks.create).toHaveBeenCalledWith(FIELDS);
  });

  it('defaults absent fields: lists empty, enabled on, DMARC checked', async () => {
    rulesMocks.create.mockResolvedValue({ id: 'rule-1' });
    await invoke('POST /forwarding-rules', {
      lambda: lambdaContext('access'),
      body: { name: 'x', senderDomains: ['a.com'], forwardTo: ['b@c.com'] },
    });
    expect(rulesMocks.create).toHaveBeenCalledWith({
      name: 'x',
      enabled: true,
      senderDomains: ['a.com'],
      senderAddresses: [],
      recipientDomains: [],
      recipientAddresses: [],
      forwardTo: ['b@c.com'],
      ignoreDmarcVerification: false,
    });
  });

  it.each([
    ['a non-array list', { forwardTo: 'b@c.com' }, '"forwardTo" must be an array of strings.'],
    ['a non-string value', { senderDomains: [1] }, '"senderDomains" must be an array of strings.'],
    ['a non-boolean flag', { ignoreDmarcVerification: 'yes' }, '"ignoreDmarcVerification" must be true or false.'],
    ['a non-string name', { name: 5 }, '"name" must be a string.'],
  ])('rejects %s with 400 before reaching the service', async (_label, body, message) => {
    const res = await invoke('POST /forwarding-rules', { lambda: lambdaContext('access'), body });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'invalid_request', message });
    expect(rulesMocks.create).not.toHaveBeenCalled();
  });

  it('updates: PUT /forwarding-rules/{id} → 200 with the id and fields', async () => {
    rulesMocks.update.mockResolvedValue({ ...FIELDS, id: 'rule-1' });
    const res = await invoke('PUT /forwarding-rules/{id}', {
      lambda: lambdaContext('access'),
      params: { id: 'rule-1' },
      body: { ...FIELDS, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(rulesMocks.update).toHaveBeenCalledWith({ ...FIELDS, enabled: false, id: 'rule-1' });
  });

  it('maps an unknown rule on update to a 404', async () => {
    rulesMocks.update.mockRejectedValue(emailErrors.notFound('No forwarding rule has that id.'));
    const res = await invoke('PUT /forwarding-rules/{id}', {
      lambda: lambdaContext('access'),
      params: { id: 'gone' },
      body: FIELDS,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}').error).toBe('not_found');
  });

  it('deletes: DELETE /forwarding-rules/{id} → 204, no content type needed', async () => {
    rulesMocks.remove.mockResolvedValue(undefined);
    const res = await invoke('DELETE /forwarding-rules/{id}', {
      lambda: lambdaContext('access'),
      params: { id: 'rule-1' },
      contentType: null,
    });
    expect(res.statusCode).toBe(204);
    expect(rulesMocks.remove).toHaveBeenCalledWith({ id: 'rule-1' });
  });
});

describe('rest handler — send email is dual-scheme', () => {
  it.each(['access', 'apiKey'])('lets a %s credential send (no access-only guard)', async (scheme) => {
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
  });
});

describe('rest handler — send passes reply fields through', () => {
  it('forwards inReplyTo and replyTo to the email service', async () => {
    const res = await invoke('POST /emails', {
      lambda: lambdaContext('access'),
      body: {
        from: 'me@example.com',
        to: ['x@y.com'],
        text: 'hi',
        inReplyTo: 'HANDLE',
        replyTo: ['desk@example.com'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMock).toHaveBeenLastCalledWith({
      from: 'me@example.com',
      to: ['x@y.com'],
      text: 'hi',
      inReplyTo: 'HANDLE',
      replyTo: ['desk@example.com'],
    });
  });

  it('forwards a stored attachment reference as is', async () => {
    await invoke('POST /emails', {
      lambda: lambdaContext('access'),
      body: {
        from: 'me@example.com',
        to: ['x@y.com'],
        text: 'fyi',
        attachments: [{ emailId: 'H', attachmentId: '2' }, { uploadId: 'U' }],
      },
    });
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attachments: [{ emailId: 'H', attachmentId: '2' }, { uploadId: 'U' }],
      }),
    );
  });

  it('rejects an attachment that is neither an upload nor a stored reference', async () => {
    const res = await invoke('POST /emails', {
      lambda: lambdaContext('access'),
      body: {
        from: 'me@example.com',
        to: ['x@y.com'],
        text: 'hi',
        attachments: [{ emailId: 'H' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('passes an idempotency key through', async () => {
    await invoke('POST /emails', {
      lambda: lambdaContext('access'),
      body: { from: 'me@example.com', to: ['x@y.com'], text: 'hi', idempotencyKey: 'k-1' },
    });
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'k-1' }));
  });

  it('rejects a non-array replyTo as a 400', async () => {
    const res = await invoke('POST /emails', {
      lambda: lambdaContext('access'),
      body: { from: 'me@example.com', to: ['x@y.com'], text: 'hi', replyTo: 'desk@example.com' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('rest handler — key management reaches the API-key service', () => {
  it('creates a key: POST /keys → 201, createApiKey called with the name', async () => {
    keysMocks.create.mockReset().mockResolvedValue({ id: 'k1', name: 'ci', createdAt: 'now', key: 'fm_raw' });
    const res = await invoke('POST /keys', {
      lambda: lambdaContext('access'),
      body: { name: 'ci' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ id: 'k1', key: 'fm_raw' });
    expect(keysMocks.create).toHaveBeenCalledWith({ name: 'ci' });
  });

  it('lists keys: GET /keys → 200, listApiKeys called', async () => {
    keysMocks.list.mockReset().mockResolvedValue({ keys: [] });
    const res = await invoke('GET /keys', { lambda: lambdaContext('access'), contentType: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ keys: [] });
    expect(keysMocks.list).toHaveBeenCalledWith({});
  });
});

describe('rest handler — attachment uploads are dual-scheme', () => {
  it.each(['access', 'apiKey'])('lets a %s credential create an upload', async (scheme) => {
    attachmentMocks.createAttachmentUpload.mockReset().mockResolvedValue({
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
    expect(attachmentMocks.createAttachmentUpload).toHaveBeenCalledWith({
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12,
    });
  });

  it('rejects a non-numeric size with 400 before reaching the service', async () => {
    attachmentMocks.createAttachmentUpload.mockReset();
    const res = await invoke('POST /attachments/uploads', {
      lambda: lambdaContext('access'),
      body: { filename: 'a.pdf', sizeBytes: '12' },
    });
    expect(res.statusCode).toBe(400);
    expect(attachmentMocks.createAttachmentUpload).not.toHaveBeenCalled();
  });
});

describe('rest handler — reads are access-token-only', () => {
  beforeEach(() => {
    readMocks.listEmails.mockReset().mockResolvedValue({ emails: [] });
    readMocks.getEmail.mockReset().mockResolvedValue({ id: 'h', direction: 'inbound' });
    readMocks.getAttachmentUrl.mockReset().mockResolvedValue({ url: 'u', expiresAt: 't' });
    readMocks.getRawUrl.mockReset().mockResolvedValue({ url: 'u', expiresAt: 't' });
  });

  it.each(['GET /emails', 'GET /emails/{id}', 'GET /emails/{id}/attachments/{attachmentId}', 'GET /emails/{id}/raw'])('rejects an x-api-key credential on %s with 403 forbidden', async (routeKey) => {
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

  it('passes the search filters through, normalized', async () => {
    await invoke('GET /emails', {
      contentType: null,
      lambda: lambdaContext('access'),
      query: { q: ' invoice ', from: 'alice', after: '2026-10-01', before: '2026-10-02T00:00Z' },
    });
    expect(readMocks.listEmails).toHaveBeenLastCalledWith({
      limit: 25,
      filters: {
        query: 'invoice',
        from: 'alice',
        after: '2026-10-01T00:00:00.000Z',
        before: '2026-10-02T00:00:00.000Z',
      },
    });
  });

  it('rejects a malformed date filter with 400', async () => {
    const res = await invoke('GET /emails', {
      contentType: null,
      lambda: lambdaContext('access'),
      query: { after: 'last week' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('defaults the limit and omits absent filters', async () => {
    await invoke('GET /emails', { contentType: null, lambda: lambdaContext('access') });
    expect(readMocks.listEmails).toHaveBeenCalledWith({ limit: 25 });
  });

  it('rejects a bad direction / non-positive-integer limit with 400', async () => {
    for (const query of [{ direction: 'bogus' }, { limit: 'abc' }, { limit: '0' }, { limit: '-3' }]) {
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

  it('gates exactly the documented eight routes', () => {
    expect(gated.sort()).toEqual(
      ['POST /auth/login', 'POST /auth/logout', 'POST /auth/refresh', 'POST /emails', 'POST /keys', 'POST /attachments/uploads', 'POST /forwarding-rules', 'PUT /forwarding-rules/{id}'].sort(),
    );
  });

  it.each(gated)('rejects %s with 415 when the content type is a simple-request type', async (routeKey) => {
    const res = await invoke(routeKey, {
      contentType: 'application/x-www-form-urlencoded',
      lambda: lambdaContext('access'),
    });
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body ?? '{}').error).toBe('unsupported_media_type');
  });

  it.each(gated)('rejects %s with 415 when the content-type header is absent entirely', async (routeKey) => {
    const res = await invoke(routeKey, { contentType: null, lambda: lambdaContext('access') });
    expect(res.statusCode).toBe(415);
  });

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
    attachmentMocks.resolveAttachmentDownloadPresignedUrl.mockResolvedValue({
      url: 'https://s3.example.com/signed-get',
    });
    const res = await invoke('GET /d/{token}', { contentType: null, params: { token: 'tok-abc' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers?.location).toBe('https://s3.example.com/signed-get');
    expect(res.headers?.['cache-control']).toBe('no-store');
    // No S3 key/bucket disclosed, and — unlike `res.redirect()` — no body echoing the
    // presigned URL either.
    expect(res.body).toBe('');
    expect(attachmentMocks.resolveAttachmentDownloadPresignedUrl).toHaveBeenCalledWith({
      token: 'tok-abc',
    });
  });

  it('serves a uniform 404 HTML page for any invalid/expired/revoked/exhausted token', async () => {
    attachmentMocks.resolveAttachmentDownloadPresignedUrl.mockResolvedValue(null);
    const res = await invoke('GET /d/{token}', { contentType: null, params: { token: 'tok-bad' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers?.['content-type']).toContain('text/html');
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toContain('no longer available');
    // The failing token is never reflected into the page (no oracle, no reflected XSS).
    expect(res.body).not.toContain('tok-bad');
  });
});

describe('rest handler — /api/* serves IAM callers only', () => {
  const API_ROUTE = 'ANY /api/{proxy+}';
  const CALLER = {
    accountId: '111111111111',
    userArn: 'arn:aws:sts::111111111111:assumed-role/caller-role/session',
  };
  const get = (path: string, options: EventOptions) => invoke(API_ROUTE, { method: 'GET', path, contentType: null, ...options });

  it('answers GET /api/test with the verified caller', async () => {
    const res = await get('/api/test', { iam: CALLER });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ ok: true, caller: CALLER });
  });

  it.each([
    ['a session (cookie) caller', { lambda: lambdaContext('access') }],
    ['an API-key caller', { lambda: lambdaContext('apiKey') }],
    ['a request with no authorizer context', {}],
  ])('refuses %s with 403', async (_label, options) => {
    expect((await get('/api/test', options)).statusCode).toBe(403);
  });

  it('refuses a non-IAM caller on an unknown /api path too (403, not 404)', async () => {
    expect((await get('/api/nope', { lambda: lambdaContext('access') })).statusCode).toBe(403);
  });

  it('gives an IAM caller the 404 on an unknown /api path', async () => {
    expect(reachedTerminal404(await get('/api/nope', { iam: CALLER }))).toBe(true);
  });

  it.each(['GET /me', 'GET /keys', 'GET /emails', 'POST /emails', 'POST /attachments/uploads'])('never lets an IAM caller through the session/API-key guards on %s', async (routeKey) => {
    const res = await invoke(routeKey, { iam: CALLER, body: { from: 'me@example.com' } });
    expect([401, 403]).toContain(res.statusCode);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('rest handler — GET /api/emails/{id} (IAM only)', () => {
  const API_ROUTE = 'ANY /api/{proxy+}';
  const CALLER = {
    accountId: '111111111111',
    userArn: 'arn:aws:sts::111111111111:assumed-role/caller-role/session',
  };
  const DETAIL = {
    id: 'handle-1',
    direction: 'inbound',
    subject: 'PO 1234',
    attachments: [
      {
        id: '0',
        filename: 'po.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        downloadUrl: 'https://s3.example/po?sig',
        downloadUrlExpiresAt: '2026-11-12T22:10:00.000Z',
      },
    ],
  };
  const get = (path: string, options: EventOptions) => invoke(API_ROUTE, { method: 'GET', path, contentType: null, ...options });

  beforeEach(() => {
    readMocks.getEmailWithDownloadUrls.mockReset();
  });

  it('returns the message, with download URLs, for the handle in the path', async () => {
    readMocks.getEmailWithDownloadUrls.mockResolvedValue(DETAIL);
    const res = await get('/api/emails/handle-1', { iam: CALLER });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual(DETAIL);
    expect(readMocks.getEmailWithDownloadUrls).toHaveBeenCalledWith({ handle: 'handle-1' });
  });

  it('maps an unknown handle to a 404', async () => {
    readMocks.getEmailWithDownloadUrls.mockRejectedValue(emailErrors.notFound('No such email.'));
    const res = await get('/api/emails/nope', { iam: CALLER });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ error: 'not_found' });
  });

  it.each([
    ['a session (cookie) caller', { lambda: lambdaContext('access') }],
    ['an API-key caller', { lambda: lambdaContext('apiKey') }],
    ['a request with no authorizer context', {}],
  ])('refuses %s with 403, without reading the message', async (_label, options) => {
    expect((await get('/api/emails/handle-1', options)).statusCode).toBe(403);
    expect(readMocks.getEmailWithDownloadUrls).not.toHaveBeenCalled();
  });
});
