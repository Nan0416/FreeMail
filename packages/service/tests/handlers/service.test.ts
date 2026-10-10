import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { Express } from 'express';
import { Router } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { authErrors } from '../../src/utils/errors.js';
import { emailErrors } from '../../src/utils/errors.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/index.js';
import type { Endpoints } from '../../src/routes/endpoints.js';
import { FreeMailService } from '../../src/handlers/service.js';
import { toApiGatewayHandler } from '../../src/handlers/serverless-express.js';

/** An Endpoints that mounts one route, so the app can be exercised without any AWS wiring. */
function endpointsFor(
  method: 'get' | 'post',
  path: string,
  handler: Parameters<Router['get']>[1],
): Endpoints {
  const router = Router();
  router[method](path, handler);
  return { bind: (app: Express) => app.use(router) };
}

function buildApp(endpoints: Endpoints[]): Express {
  return new FreeMailService({
    middleware: [],
    endpoints,
    notFoundHandler,
    errorHandler,
  }).init();
}

interface CallResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly text: string;
  readonly body: unknown;
}

const LAMBDA_CONTEXT = { callbackWaitsForEmptyEventLoop: false } as unknown as Context;

/**
 * Drive the app in-process through the same API Gateway adapter the Lambda uses — no socket,
 * so nothing here depends on the machine's networking.
 */
async function call(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly contentType?: string; readonly body?: string } = {},
): Promise<CallResponse> {
  const event = {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: options.contentType ? { 'content-type': options.contentType } : {},
    ...(options.body === undefined ? {} : { body: options.body }),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
    },
  } as unknown as APIGatewayProxyEventV2;
  const result = await toApiGatewayHandler(app)(event, LAMBDA_CONTEXT, () => {});
  const text = result.body ?? '';
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    headers[name.toLowerCase()] = String(value);
  }
  const isJson = headers['content-type']?.includes('application/json') ?? false;
  return {
    status: result.statusCode ?? 0,
    headers,
    text,
    body: isJson && text !== '' ? JSON.parse(text) : undefined,
  };
}

describe('FreeMailService app assembly', () => {
  it('answers an unmatched route with the standard JSON error body, not Express HTML', async () => {
    const res = await call(buildApp([]), 'GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'invalid_request', message: 'Not found.' });
  });

  it('does not advertise the framework', async () => {
    const app = buildApp([endpointsFor('get', '/ok', (_req, res) => void res.status(200).end())]);
    const res = await call(app, 'GET', '/ok');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('parses a JSON body', async () => {
    const app = buildApp([
      endpointsFor('post', '/echo', (req, res) => void res.status(200).json(req.body)),
    ]);
    const res = await call(app, 'POST', '/echo', {
      contentType: 'application/json',
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('does NOT parse a form-encoded body — that is the shape #47 Layer 3 exists to refuse', async () => {
    // Registering `express.urlencoded()` would make the exact content type a cross-site
    // <form> POST can send without a preflight into a first-class input format.
    const app = buildApp([
      endpointsFor('post', '/echo', (req, res) => void res.status(200).json(req.body ?? null)),
    ]);
    const res = await call(app, 'POST', '/echo', {
      contentType: 'application/x-www-form-urlencoded',
      body: 'hello=world',
    });
    expect(res.body).not.toEqual({ hello: 'world' });
  });
});

describe('errorHandler', () => {
  it('renders an AuthError with its status and wire code', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(authErrors.forbidden('nope'))),
    ]);
    const res = await call(app, 'GET', '/boom');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: 'nope' });
  });

  it('renders an EmailError the same way', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(emailErrors.notFound('gone'))),
    ]);
    const res = await call(app, 'GET', '/boom');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'gone' });
  });

  it('attaches Retry-After when a lockout supplies one', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(authErrors.accountLocked(90))),
    ]);
    const res = await call(app, 'GET', '/boom');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('90');
  });

  it('translates a malformed JSON body into a 400, not a 500', async () => {
    const app = buildApp([
      endpointsFor('post', '/echo', (_req, res) => void res.status(200).end()),
    ]);
    const res = await call(app, 'POST', '/echo', {
      contentType: 'application/json',
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_request',
      message: 'Request body must be valid JSON.',
    });
  });

  it('flattens an unexpected error to a clean 500 that leaks nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = buildApp([
        endpointsFor('get', '/boom', (_req, _res, next) => {
          next(new Error('internal detail that must not escape'));
        }),
      ]);
      const res = await call(app, 'GET', '/boom');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'invalid_request', message: 'Internal error.' });
      expect(res.text).not.toContain('internal detail');
    } finally {
      spy.mockRestore();
    }
  });
});
