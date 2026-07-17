import { describe, expect, it, vi } from 'vitest';
import { ApiError, FreeMailClient } from './client.js';
import { createTokenStore, type TokenStore } from './token-store.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = 'http://api.test';
const PAIR = {
  tokenType: 'Bearer',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 900,
};

function makeClient(
  fetchImpl: typeof fetch,
  opts: { onAuthLost?: () => void; tokens?: TokenStore } = {},
): { client: FreeMailClient; tokens: TokenStore } {
  const tokens = opts.tokens ?? createTokenStore(memoryStorage());
  const client = new FreeMailClient({
    baseUrl: BASE,
    tokens,
    fetchImpl,
    onAuthLost: opts.onAuthLost,
  });
  return { client, tokens };
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

describe('FreeMailClient', () => {
  it('login stores the token pair and sends Bearer auth on the next call', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, PAIR))
      .mockResolvedValueOnce(json(200, { subject: 'owner' }));
    const { client, tokens } = makeClient(fetchMock);

    await client.login('a-strong-password');
    expect(tokens.getAccessToken()).toBe('access-1');
    expect(tokens.getRefreshToken()).toBe('refresh-1');

    const session = await client.getSession();
    expect(session).toEqual({ subject: 'owner' });

    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe(`${BASE}/auth/login`);
    expect(loginInit?.method).toBe('POST');
    expect(JSON.parse(String(loginInit?.body))).toEqual({ password: 'a-strong-password' });
    expect(authHeader(loginInit)).toBeUndefined();

    const [meUrl, meInit] = fetchMock.mock.calls[1];
    expect(meUrl).toBe(`${BASE}/me`);
    expect(authHeader(meInit)).toBe('Bearer access-1');
  });

  it('refreshes once and retries after a 401, rotating the stored refresh token', async () => {
    let refreshed = false;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, PAIR);
      if (path === '/auth/refresh') {
        refreshed = true;
        return json(200, { ...PAIR, accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      if (path === '/me') {
        return refreshed
          ? json(200, { subject: 'owner', usedAuth: authHeader(init) })
          : json(401, { error: 'invalid_token', message: 'expired' });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { client, tokens } = makeClient(fetchMock);
    await client.login('a-strong-password');

    const session = (await client.getSession()) as { subject: string; usedAuth: string };
    expect(session.subject).toBe('owner');
    // the retry used the rotated access token
    expect(session.usedAuth).toBe('Bearer access-2');
    // the rotated refresh token was persisted
    expect(tokens.getRefreshToken()).toBe('refresh-2');

    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/auth/refresh',
    );
    expect(refreshCalls).toHaveLength(1);
    expect(JSON.parse(String(refreshCalls[0][1]?.body))).toEqual({ refreshToken: 'refresh-1' });
  });

  it('single-flights concurrent 401s into ONE refresh', async () => {
    let refreshed = false;
    let refreshCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, PAIR);
      if (path === '/auth/refresh') {
        refreshCount += 1;
        refreshed = true;
        return json(200, { ...PAIR, accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      if (path === '/me' || path === '/keys') {
        return refreshed
          ? json(200, path === '/keys' ? { keys: [] } : { subject: 'owner' })
          : json(401, { error: 'invalid_token', message: 'expired' });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { client } = makeClient(fetchMock);
    await client.login('a-strong-password');

    await Promise.all([client.getSession(), client.listKeys()]);
    expect(refreshCount).toBe(1);
  });

  it('clears auth and fires onAuthLost when the refresh itself fails', async () => {
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, PAIR);
      if (path === '/me') return json(401, { error: 'invalid_token', message: 'expired' });
      if (path === '/auth/refresh') return json(401, { error: 'invalid_token', message: 'gone' });
      throw new Error(`unexpected ${path}`);
    });
    const { client, tokens } = makeClient(fetchMock, { onAuthLost });
    await client.login('a-strong-password');

    await expect(client.getSession()).rejects.toMatchObject({ status: 401 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(tokens.getAccessToken()).toBeNull();
    expect(tokens.getRefreshToken()).toBeNull();
    expect(client.hasSession()).toBe(false);
  });

  it('clears auth and fires onAuthLost when the refresh request THROWS (network error)', async () => {
    const onAuthLost = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, PAIR);
      if (path === '/me') return json(401, { error: 'invalid_token', message: 'expired' });
      if (path === '/auth/refresh') throw new TypeError('Failed to fetch');
      throw new Error(`unexpected ${path}`);
    });
    const { client, tokens } = makeClient(fetchMock, { onAuthLost });
    await client.login('a-strong-password');

    // A thrown refresh must not escape past cleanup — same outcome as a non-2xx refresh.
    await expect(client.getSession()).rejects.toMatchObject({ status: 401 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(tokens.getAccessToken()).toBeNull();
    expect(client.hasSession()).toBe(false);
  });

  it('createKey returns the raw key once with Bearer auth', async () => {
    const created = {
      id: 'kid1',
      name: 'agent',
      createdAt: '2026-07-17T00:00:00.000Z',
      key: 'fm_kid1_secretsecret',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, PAIR))
      .mockResolvedValueOnce(json(201, created));
    const { client } = makeClient(fetchMock);
    await client.login('a-strong-password');

    const result = await client.createKey('agent');
    expect(result.key).toBe('fm_kid1_secretsecret');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/keys`);
    expect(init?.method).toBe('POST');
    expect(authHeader(init)).toBe('Bearer access-1');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'agent' });
  });

  it('sendEmail posts the message and returns the send result', async () => {
    const sendResult = { id: 'm1', messageId: 'ses-1', sentAt: '2026-07-17T00:00:00.000Z' };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, PAIR))
      .mockResolvedValueOnce(json(200, sendResult));
    const { client } = makeClient(fetchMock);
    await client.login('a-strong-password');

    const result = await client.sendEmail({ from: 'a@x.com', to: ['b@y.com'], text: 'hi' });
    expect(result).toEqual(sendResult);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/emails`);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'a@x.com',
      to: ['b@y.com'],
      text: 'hi',
    });
  });

  it('logout revokes server-side and clears local state', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, PAIR))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { client, tokens } = makeClient(fetchMock);
    await client.login('a-strong-password');

    await client.logout();
    expect(client.hasSession()).toBe(false);
    expect(tokens.getRefreshToken()).toBeNull();
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/auth/logout`);
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-1' });
  });

  it('surfaces the server error body as a typed ApiError', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(400, { error: 'weak_password', message: 'too short' }));
    const { client } = makeClient(fetchMock);
    const rejection = client.setPassword('short');
    await expect(rejection).rejects.toBeInstanceOf(ApiError);
    await expect(rejection).rejects.toMatchObject({
      status: 400,
      code: 'weak_password',
      message: 'too short',
    });
  });
});
