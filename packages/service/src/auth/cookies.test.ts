import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE,
  DUPLICATE_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  readCookie,
  sessionCookies,
} from './cookies.js';

describe('session cookie serialization', () => {
  it('sets both cookies HttpOnly, Secure, SameSite=Strict, Path=/ with the TTL max-age', () => {
    const [access, refresh] = sessionCookies('access.jwt.value', 'rt_refreshtoken');

    for (const cookie of [access, refresh]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
    }
    // __Host- prefix requires exactly Secure + Path=/ + NO Domain.
    expect(access.startsWith(`${ACCESS_COOKIE}=access.jwt.value;`)).toBe(true);
    expect(refresh.startsWith(`${REFRESH_COOKIE}=rt_refreshtoken;`)).toBe(true);
    expect(access).not.toContain('Domain=');
    expect(refresh).not.toContain('Domain=');
    expect(access).toContain(`Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`);
    expect(refresh).toContain(`Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`);
  });

  it('clears both cookies with an empty value and Max-Age=0, same attributes', () => {
    const [access, refresh] = clearSessionCookies();
    expect(access).toBe(`${ACCESS_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    expect(refresh).toBe(
      `${REFRESH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    );
  });
});

describe('readCookie', () => {
  it('returns the single value for a present cookie', () => {
    expect(readCookie(['a=1', `${ACCESS_COOKIE}=tok`, 'b=2'], ACCESS_COOKIE)).toBe('tok');
  });

  it('returns null when the cookie is absent or the array is undefined', () => {
    expect(readCookie(['a=1', 'b=2'], ACCESS_COOKIE)).toBeNull();
    expect(readCookie(undefined, ACCESS_COOKIE)).toBeNull();
  });

  it('rejects a duplicate (injected/shadowing) same-name cookie rather than guessing', () => {
    expect(readCookie([`${ACCESS_COOKIE}=real`, `${ACCESS_COOKIE}=evil`], ACCESS_COOKIE)).toBe(
      DUPLICATE_COOKIE,
    );
    // Even identical duplicates are rejected — we never pick first or last.
    expect(readCookie([`${ACCESS_COOKIE}=x`, `${ACCESS_COOKIE}=x`], ACCESS_COOKIE)).toBe(
      DUPLICATE_COOKIE,
    );
  });

  it('splits on the first "=" so a token containing "." or "=" survives intact', () => {
    expect(readCookie([`${ACCESS_COOKIE}=aaa.bbb.ccc==`], ACCESS_COOKIE)).toBe('aaa.bbb.ccc==');
  });

  it('trims whitespace around a cookie name', () => {
    expect(readCookie([` ${REFRESH_COOKIE}=rt`], REFRESH_COOKIE)).toBe('rt');
  });
});
