import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_COOKIE } from '../auth/cookies.js';
import { handler } from './authorizer.js';

vi.mock('../config/signing-key.js', () => ({
  getSigningKey: () => Promise.resolve('test-key'),
}));

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock('../auth/jwt.js', () => ({ verifyAccessToken: verifyMock }));

const { verifyKeyMock } = vi.hoisted(() => ({ verifyKeyMock: vi.fn() }));
vi.mock('../keys/service.js', () => ({
  ApiKeyService: class {
    verify = verifyKeyMock;
  },
}));
vi.mock('../data/ddb-keys-repo.js', () => ({ DdbApiKeysRepo: class {} }));

function event(opts: {
  cookies?: string[];
  headers?: Record<string, string>;
}): APIGatewayRequestAuthorizerEventV2 {
  return {
    cookies: opts.cookies,
    headers: opts.headers ?? {},
  } as unknown as APIGatewayRequestAuthorizerEventV2;
}

beforeEach(() => {
  process.env.API_KEYS_TABLE = 'keys-test';
  verifyMock.mockReset();
  verifyKeyMock.mockReset();
});

afterEach(() => {
  delete process.env.API_KEYS_TABLE;
});

describe('authorizer — access via httpOnly cookie', () => {
  it('authorizes a valid access cookie as the access scheme', async () => {
    verifyMock.mockResolvedValue({ valid: true, claims: { sub: 'owner' } });
    const res = await handler(event({ cookies: [`${ACCESS_COOKIE}=good.jwt`] }));
    expect(res).toEqual({ isAuthorized: true, context: { sub: 'owner', scheme: 'access' } });
    expect(verifyMock).toHaveBeenCalledWith('good.jwt', 'test-key', expect.any(Number));
  });

  it('denies an invalid access cookie', async () => {
    verifyMock.mockResolvedValue({ valid: false });
    const res = await handler(event({ cookies: [`${ACCESS_COOKIE}=bad.jwt`] }));
    expect(res).toEqual({ isAuthorized: false, context: {} });
  });

  it('denies a duplicate/injected access cookie WITHOUT verifying either value', async () => {
    const res = await handler(event({ cookies: [`${ACCESS_COOKIE}=one`, `${ACCESS_COOKIE}=two`] }));
    expect(res).toEqual({ isAuthorized: false, context: {} });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('ignores a Bearer Authorization header (Bearer was dropped for the web session)', async () => {
    const res = await handler(event({ headers: { authorization: 'Bearer some.jwt' } }));
    expect(res).toEqual({ isAuthorized: false, context: {} });
    expect(verifyMock).not.toHaveBeenCalled();
    expect(verifyKeyMock).not.toHaveBeenCalled();
  });
});

describe('authorizer — x-api-key branch unchanged', () => {
  it('authorizes a valid x-api-key as the owner/apiKey scheme when no cookie is present', async () => {
    verifyKeyMock.mockResolvedValue('kid1');
    const res = await handler(event({ headers: { 'x-api-key': 'fm_kid1_secret' } }));
    expect(res).toEqual({ isAuthorized: true, context: { sub: 'owner', scheme: 'apiKey' } });
  });

  it('denies an invalid x-api-key', async () => {
    verifyKeyMock.mockResolvedValue(null);
    const res = await handler(event({ headers: { 'x-api-key': 'fm_bad' } }));
    expect(res).toEqual({ isAuthorized: false, context: {} });
  });

  it('denies when no credential is present at all', async () => {
    const res = await handler(event({}));
    expect(res).toEqual({ isAuthorized: false, context: {} });
  });
});
