import { describe, expect, it } from 'vitest';
import { createTokenStore } from './token-store.js';

function memoryStorage(): Storage & { raw: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    raw: map,
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

describe('createTokenStore', () => {
  it('keeps the access token in memory only — never in storage', () => {
    const storage = memoryStorage();
    const store = createTokenStore(storage);
    store.setTokens({ accessToken: 'a', refreshToken: 'r' });

    expect(store.getAccessToken()).toBe('a');
    // the refresh token is persisted, the access token is not
    expect(store.getRefreshToken()).toBe('r');
    expect([...storage.raw.values()]).toContain('r');
    expect([...storage.raw.values()]).not.toContain('a');
  });

  it('clear() drops both tokens', () => {
    const storage = memoryStorage();
    const store = createTokenStore(storage);
    store.setTokens({ accessToken: 'a', refreshToken: 'r' });
    store.clear();

    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(storage.raw.size).toBe(0);
  });

  it('setTokens overwrites (rotation replaces the stored refresh token)', () => {
    const store = createTokenStore(memoryStorage());
    store.setTokens({ accessToken: 'a1', refreshToken: 'r1' });
    store.setTokens({ accessToken: 'a2', refreshToken: 'r2' });
    expect(store.getAccessToken()).toBe('a2');
    expect(store.getRefreshToken()).toBe('r2');
  });
});
