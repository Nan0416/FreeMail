import { describe, expect, it } from 'vitest';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

describe('refresh tokens', () => {
  it('mints prefixed, unique, high-entropy tokens', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.startsWith('rt_')).toBe(true);
    expect(a).not.toBe(b);
    // 32 random bytes → 43 base64url chars, plus the 3-char prefix.
    expect(a.length).toBeGreaterThanOrEqual(45);
  });

  it('hashes deterministically and differently per token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(hashRefreshToken(generateRefreshToken()));
    // SHA-256 hex.
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
