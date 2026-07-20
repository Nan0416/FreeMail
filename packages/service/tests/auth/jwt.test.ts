import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../../src/auth/jwt.js';

const KEY = 'test-signing-key-0123456789';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('access token JWT', () => {
  it('signs and verifies a token', async () => {
    const token = await signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    const result = await verifyAccessToken(token, KEY, 1000);
    expect(result).toEqual({ valid: true, claims: { sub: 'owner', iat: 1000, exp: 1900 } });
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    expect(await verifyAccessToken(token, KEY, 1900)).toEqual({ valid: false, reason: 'expired' });
    expect(await verifyAccessToken(token, KEY, 5000)).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a token signed with a different key', async () => {
    const token = await signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    expect(await verifyAccessToken(token, 'other-key', 1000)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${b64url({ sub: 'attacker', iat: 1000, exp: 1900 })}.${signature}`;
    expect(await verifyAccessToken(forged, KEY, 1000)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('rejects the alg=none downgrade', async () => {
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({ sub: 'attacker', iat: 1000, exp: 1900 });
    expect(await verifyAccessToken(`${header}.${payload}.`, KEY, 1000)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects structurally malformed tokens', async () => {
    expect(await verifyAccessToken('only.two', KEY, 1000)).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(await verifyAccessToken('a.b.c', KEY, 1000)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
