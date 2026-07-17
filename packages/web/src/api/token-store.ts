import type { TokenPair } from '@freemail/shared';

/** sessionStorage key holding the rotating refresh token. */
const REFRESH_KEY = 'freemail.refreshToken';

export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  /** Store a freshly issued/rotated pair. Overwrites both. */
  setTokens(pair: Pick<TokenPair, 'accessToken' | 'refreshToken'>): void;
  /** Drop all auth state (logout, or an unrecoverable refresh failure). */
  clear(): void;
}

/**
 * The access token lives ONLY in memory (this closure) — it is never written to
 * any storage, so injected script cannot read it back out of `localStorage` /
 * `sessionStorage`. The refresh token lives in `sessionStorage`: it survives an
 * in-tab reload (so the user is not forced to re-login on refresh) but is cleared
 * when the tab closes, shrinking the window in which a stolen token is usable —
 * the ruling on issue #8's token-storage question. `localStorage` was rejected
 * for its durable-across-sessions theft risk.
 *
 * The `Storage` is injectable so tests can supply an in-memory stub instead of the
 * jsdom global.
 */
export function createTokenStore(storage: Storage = window.sessionStorage): TokenStore {
  let accessToken: string | null = null;
  return {
    getAccessToken: () => accessToken,
    getRefreshToken: () => storage.getItem(REFRESH_KEY),
    setTokens: ({ accessToken: newAccess, refreshToken }) => {
      accessToken = newAccess;
      storage.setItem(REFRESH_KEY, refreshToken);
    },
    clear: () => {
      accessToken = null;
      storage.removeItem(REFRESH_KEY);
    },
  };
}
