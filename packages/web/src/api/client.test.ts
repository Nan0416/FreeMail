import { describe, expect, it, vi } from 'vitest';
import { ApiError, FreeMailClient } from './client.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = 'http://api.test';

function makeClient(
  fetchImpl: typeof fetch,
  opts: { onAuthLost?: () => void } = {},
): FreeMailClient {
  return new FreeMailClient({ baseUrl: BASE, fetchImpl, onAuthLost: opts.onAuthLost });
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

describe('FreeMailClient (cookie auth)', () => {
  it('never sends an Authorization header and always includes credentials', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { subject: 'owner' }))
      .mockResolvedValueOnce(json(200, { subject: 'owner' }));
    const client = makeClient(fetchMock);

    const login = await client.login('a-strong-password');
    expect(login).toEqual({ subject: 'owner' });
    await client.getSession();

    for (const [, init] of fetchMock.mock.calls) {
      expect(authHeader(init)).toBeUndefined();
      expect(init?.credentials).toBe('include');
    }
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe(`${BASE}/auth/login`);
    expect(JSON.parse(String(loginInit?.body))).toEqual({ password: 'a-strong-password' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/me`);
  });

  it('refreshes once and retries after a 403 (authorizer deny on an expired access cookie)', async () => {
    let refreshed = false;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/refresh') {
        refreshed = true;
        return new Response(null, { status: 204 });
      }
      if (path === '/me') {
        return refreshed
          ? json(200, { subject: 'owner' })
          : json(403, { error: 'invalid_token', message: 'expired' });
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = makeClient(fetchMock);

    const session = await client.getSession();
    expect(session).toEqual({ subject: 'owner' });

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/auth/refresh',
    );
    expect(refreshCalls).toHaveLength(1);
    // The refresh token rides in the cookie — never a request body.
    expect(refreshCalls[0][1]?.body).toBeUndefined();
    expect(refreshCalls[0][1]?.credentials).toBe('include');
  });

  it('also refreshes on a 401 for an authenticated request', async () => {
    let refreshed = false;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/refresh') {
        refreshed = true;
        return new Response(null, { status: 204 });
      }
      if (path === '/keys') {
        return refreshed
          ? json(200, { keys: [] })
          : json(401, { error: 'invalid_token', message: 'expired' });
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = makeClient(fetchMock);
    await expect(client.listKeys()).resolves.toEqual({ keys: [] });
  });

  it('single-flights concurrent auth failures into ONE refresh', async () => {
    let refreshed = false;
    let refreshCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/refresh') {
        refreshCount += 1;
        refreshed = true;
        return new Response(null, { status: 204 });
      }
      if (path === '/me' || path === '/keys') {
        return refreshed
          ? json(200, path === '/keys' ? { keys: [] } : { subject: 'owner' })
          : json(403, { error: 'invalid_token', message: 'expired' });
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = makeClient(fetchMock);

    await Promise.all([client.getSession(), client.listKeys()]);
    expect(refreshCount).toBe(1);
  });

  it('fires onAuthLost when the refresh itself fails (non-2xx)', async () => {
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') return json(403, { error: 'invalid_token', message: 'expired' });
      if (path === '/auth/refresh') return json(401, { error: 'invalid_token', message: 'gone' });
      throw new Error(`unexpected ${path}`);
    });
    const client = makeClient(fetchMock, { onAuthLost });

    await expect(client.getSession()).rejects.toMatchObject({ status: 403 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('fires onAuthLost when the refresh request THROWS (network error)', async () => {
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') return json(401, { error: 'invalid_token', message: 'expired' });
      if (path === '/auth/refresh') throw new TypeError('Failed to fetch');
      throw new Error(`unexpected ${path}`);
    });
    const client = makeClient(fetchMock, { onAuthLost });

    await expect(client.getSession()).rejects.toMatchObject({ status: 401 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('createKey returns the raw key once, credentialed with no auth header', async () => {
    const created = {
      id: 'kid1',
      name: 'agent',
      createdAt: '2026-07-17T00:00:00.000Z',
      key: 'fm_kid1_secretsecret',
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(201, created));
    const client = makeClient(fetchMock);

    const result = await client.createKey('agent');
    expect(result.key).toBe('fm_kid1_secretsecret');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/keys`);
    expect(init?.method).toBe('POST');
    expect(authHeader(init)).toBeUndefined();
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'agent' });
  });

  it('sendEmail posts the message and returns the send result', async () => {
    const sendResult = { id: 'm1', messageId: 'ses-1', sentAt: '2026-07-17T00:00:00.000Z' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(200, sendResult));
    const client = makeClient(fetchMock);

    const result = await client.sendEmail({ from: 'a@x.com', to: ['b@y.com'], text: 'hi' });
    expect(result).toEqual(sendResult);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/emails`);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'a@x.com',
      to: ['b@y.com'],
      text: 'hi',
    });
  });

  it('logout posts to the revoke endpoint with no body and resolves on a 2xx', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = makeClient(fetchMock);

    await expect(client.logout()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/auth/logout`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe('include');
  });

  it('PROPAGATES a logout failure — only a 2xx clears the httpOnly cookies', async () => {
    // Non-2xx: the server did not confirm a clean revoke → the caller must know.
    const nonOk = makeClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(500, { error: 'invalid_request', message: 'retry' })),
    );
    await expect(nonOk.logout()).rejects.toMatchObject({ status: 500 });

    // Network failure: the request never reached the server → cookies untouched.
    const networkDown = makeClient(
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(networkDown.logout()).rejects.toBeInstanceOf(TypeError);
  });

  it('surfaces the server error body as a typed ApiError', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(400, { error: 'weak_password', message: 'too short' }));
    const client = makeClient(fetchMock);
    const rejection = client.setPassword('short');
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({
      status: 400,
      code: 'weak_password',
      message: 'too short',
    });
  });
});
