import type { Express } from 'express';
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { authErrors } from '../../src/utils/errors.js';
import { emailErrors } from '../../src/utils/errors.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/index.js';
import type { Endpoints } from '../../src/routes/endpoints.js';
import { FreeMailService } from '../../src/handlers/service.js';

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

describe('FreeMailService app assembly', () => {
  it('answers an unmatched route with the standard JSON error body, not Express HTML', async () => {
    const res = await request(buildApp([])).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'invalid_request', message: 'Not found.' });
  });

  it('does not advertise the framework', async () => {
    const app = buildApp([endpointsFor('get', '/ok', (_req, res) => void res.status(200).end())]);
    const res = await request(app).get('/ok');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('parses a JSON body', async () => {
    const app = buildApp([
      endpointsFor('post', '/echo', (req, res) => void res.status(200).json(req.body)),
    ]);
    const res = await request(app).post('/echo').send({ hello: 'world' });
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('does NOT parse a form-encoded body — that is the shape #47 Layer 3 exists to refuse', async () => {
    // Registering `express.urlencoded()` would make the exact content type a cross-site
    // <form> POST can send without a preflight into a first-class input format.
    const app = buildApp([
      endpointsFor('post', '/echo', (req, res) => void res.status(200).json(req.body ?? null)),
    ]);
    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('hello=world');
    expect(res.body).not.toEqual({ hello: 'world' });
  });
});

describe('errorHandler', () => {
  it('renders an AuthError with its status and wire code', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(authErrors.forbidden('nope'))),
    ]);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: 'nope' });
  });

  it('renders an EmailError the same way', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(emailErrors.notFound('gone'))),
    ]);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'gone' });
  });

  it('attaches Retry-After when a lockout supplies one', async () => {
    const app = buildApp([
      endpointsFor('get', '/boom', (_req, _res, next) => next(authErrors.accountLocked(90))),
    ]);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('90');
  });

  it('translates a malformed JSON body into a 400, not a 500', async () => {
    const app = buildApp([
      endpointsFor('post', '/echo', (_req, res) => void res.status(200).end()),
    ]);
    const res = await request(app)
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{not json');
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
      const res = await request(app).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'invalid_request', message: 'Internal error.' });
      expect(res.text).not.toContain('internal detail');
    } finally {
      spy.mockRestore();
    }
  });
});
