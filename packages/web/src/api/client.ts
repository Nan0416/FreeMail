import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RefreshResponse,
  SendEmailRequest,
  SendEmailResponse,
  SessionResponse,
  TokenPair,
} from '@freemail/shared';
import type { TokenStore } from './token-store.js';

/** A typed error carrying the server's `{ error, message }` body plus the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'DELETE';

export interface FreeMailClientOptions {
  /** API base URL (no trailing slash), from the runtime `config.json`. */
  baseUrl: string;
  tokens: TokenStore;
  /** Injectable for tests; defaults to a `fetch` that keeps the global binding. */
  fetchImpl?: typeof fetch;
  /** Invoked when auth is irrecoverably lost (a refresh failed) so the UI can drop to the sign-in screen. */
  onAuthLost?: () => void;
}

/**
 * Thin typed client over the FreeMail REST API. All auth is Bearer (no cookies),
 * matching the API's wildcard-origin CORS. On a 401 for an authenticated request
 * it transparently refreshes once and retries:
 *
 *  - **single-flight** — concurrent 401s share ONE in-flight `/auth/refresh`, so a
 *    burst of requests rotates the refresh token exactly once (rotation replaces
 *    the stored token immediately);
 *  - **retry-once** — the retried request is returned as-is even if it 401s again
 *    (no refresh loop);
 *  - **clear-on-failure** — if the refresh itself fails, all auth state is dropped
 *    and `onAuthLost` fires.
 */
export class FreeMailClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onAuthLost?: () => void;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(opts: FreeMailClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.tokens = opts.tokens;
    // Wrap rather than pass `fetch` directly so the global `this` binding is kept.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onAuthLost = opts.onAuthLost;
  }

  /** True when a refresh token is present — the app treats this as "has a session". */
  hasSession(): boolean {
    return this.tokens.getRefreshToken() !== null;
  }

  // --- unauthenticated ---

  /** First-run only: set the single account password. 409 `password_already_set` if one exists. */
  async setPassword(password: string): Promise<void> {
    await this.request('POST', '/auth/set-password', { body: { password }, auth: false });
  }

  /** Verify the password and store the issued token pair. */
  async login(password: string): Promise<void> {
    const pair = await this.request<TokenPair>('POST', '/auth/login', {
      body: { password },
      auth: false,
    });
    this.tokens.setTokens(pair);
  }

  /** Best-effort server-side revoke, then drop local auth state unconditionally. */
  async logout(): Promise<void> {
    const refreshToken = this.tokens.getRefreshToken();
    this.tokens.clear();
    if (refreshToken) {
      try {
        await this.request('POST', '/auth/logout', { body: { refreshToken }, auth: false });
      } catch {
        // Local state is already cleared; a failed server revoke must not block sign-out.
      }
    }
  }

  // --- authenticated ---

  async getSession(): Promise<SessionResponse> {
    return this.request<SessionResponse>('GET', '/me', { auth: true });
  }

  async sendEmail(req: SendEmailRequest): Promise<SendEmailResponse> {
    return this.request<SendEmailResponse>('POST', '/emails', { body: req, auth: true });
  }

  async listKeys(): Promise<ListApiKeysResponse> {
    return this.request<ListApiKeysResponse>('GET', '/keys', { auth: true });
  }

  /** Mint a new API key. The raw key is in the response exactly once. */
  async createKey(name?: string): Promise<CreateApiKeyResponse> {
    return this.request<CreateApiKeyResponse>('POST', '/keys', {
      body: name ? { name } : {},
      auth: true,
    });
  }

  async revokeKey(id: string): Promise<void> {
    await this.request('DELETE', `/keys/${encodeURIComponent(id)}`, { auth: true });
  }

  // --- core ---

  private async request<T = void>(
    method: Method,
    path: string,
    opts: { body?: unknown; auth: boolean },
  ): Promise<T> {
    const response = await this.rawRequest(method, path, opts.body, opts.auth);
    if (response.status === 401 && opts.auth) {
      const refreshed = await this.refreshTokens();
      if (refreshed) {
        // Retry exactly once with the rotated access token — no loop on a second 401.
        return this.parse<T>(await this.rawRequest(method, path, opts.body, true));
      }
      this.tokens.clear();
      this.onAuthLost?.();
    }
    return this.parse<T>(response);
  }

  private async rawRequest(
    method: Method,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (auth) {
      const accessToken = this.tokens.getAccessToken();
      if (accessToken) {
        headers.authorization = `Bearer ${accessToken}`;
      }
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Single-flight refresh: concurrent callers await the same rotation. */
  private async refreshTokens(): Promise<boolean> {
    this.refreshInFlight ??= this.doRefresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = this.tokens.getRefreshToken();
    if (!refreshToken) {
      return false;
    }
    // Any refresh failure — a non-2xx OR a thrown network error — resolves to
    // `false` so the caller runs the same clear + onAuthLost cleanup. A throw here
    // must not escape past that cleanup.
    try {
      const response = await this.rawRequest('POST', '/auth/refresh', { refreshToken }, false);
      if (!response.ok) {
        return false;
      }
      const pair = (await response.json()) as RefreshResponse;
      // Rotation: replace the stored refresh token immediately.
      this.tokens.setTokens(pair);
      return true;
    } catch {
      return false;
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const body = (data ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof body.error === 'string' ? body.error : 'invalid_request';
      const message =
        typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`;
      throw new ApiError(response.status, code, message);
    }
    return data as T;
  }
}
