import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from './jwt.js';

const KEY = 'test-signing-key-0123456789';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('access token JWT', () => {
  it('signs and verifies a token', () => {
    const token = signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    const result = verifyAccessToken(token, KEY, 1000);
    expect(result).toEqual({ valid: true, claims: { sub: 'owner', iat: 1000, exp: 1900 } });
  });

  it('rejects an expired token', () => {
    const token = signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    expect(verifyAccessToken(token, KEY, 1900)).toEqual({ valid: false, reason: 'expired' });
    expect(verifyAccessToken(token, KEY, 5000)).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a token signed with a different key', () => {
    const token = signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    expect(verifyAccessToken(token, 'other-key', 1000)).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload', () => {
    const token = signAccessToken(KEY, { subject: 'owner', issuedAt: 1000, ttlSeconds: 900 });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${b64url({ sub: 'attacker', iat: 1000, exp: 1900 })}.${signature}`;
    expect(verifyAccessToken(forged, KEY, 1000)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects the alg=none downgrade', () => {
    const header = b64url({ alg: 'none', typ: 'JWT' });
    const payload = b64url({ sub: 'attacker', iat: 1000, exp: 1900 });
    expect(verifyAccessToken(`${header}.${payload}.`, KEY, 1000)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects structurally malformed tokens', () => {
    expect(verifyAccessToken('only.two', KEY, 1000)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifyAccessToken('a.b.c', KEY, 1000)).toEqual({ valid: false, reason: 'malformed' });
  });
});
