import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  SendEmailRequest,
  SendEmailResponse,
  SessionResponse,
} from '@freemail/shared';

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
  /** API base URL from the runtime `config.json` — the same-origin `/api` proxy path. */
  baseUrl: string;
  /** Injectable for tests; defaults to a `fetch` that keeps the global binding. */
  fetchImpl?: typeof fetch;
  /** Invoked when auth is irrecoverably lost (a refresh failed) so the UI can drop to the sign-in screen. */
  onAuthLost?: () => void;
}

/**
 * Thin typed client over the FreeMail REST API. Auth is entirely httpOnly cookies
 * (#31): every request sends `credentials: 'include'` and NO `Authorization` header,
 * and the SPA never reads, stores, or rotates a token — the browser attaches the
 * `__Host-fm_access` / `__Host-fm_refresh` cookies and the server rotates them.
 *
 * On a 401/403 for an authenticated request (an expired access cookie surfaces as a
 * 403 from the authorizer) it transparently refreshes once and retries:
 *
 *  - **single-flight** — concurrent auth failures share ONE in-flight `/auth/refresh`
 *    (the server rotates the refresh cookie exactly once);
 *  - **retry-once** — the retried request is returned as-is even if it fails again
 *    (no refresh loop);
 *  - **clear-on-failure** — if the refresh itself fails, `onAuthLost` fires (the
 *    server has already cleared both cookies on that path).
 */
export class FreeMailClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onAuthLost?: () => void;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(opts: FreeMailClientOptions) {
    this.baseUrl = opts.baseUrl;
    // Wrap rather than pass `fetch` directly so the global `this` binding is kept.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.onAuthLost = opts.onAuthLost;
  }

  // --- unauthenticated ---

  /** First-run only: set the single account password. 409 `password_already_set` if one exists. */
  async setPassword(password: string): Promise<void> {
    await this.request('POST', '/auth/set-password', { body: { password }, auth: false });
  }

  /** Verify the password; on success the server sets the session cookies. Returns the subject. */
  async login(password: string): Promise<SessionResponse> {
    return this.request<SessionResponse>('POST', '/auth/login', {
      body: { password },
      auth: false,
    });
  }

  /**
   * Sign out: the server revokes the refresh token and clears both cookies. ONLY a
   * successful (2xx) response clears the httpOnly cookies, so a non-2xx or network
   * failure is PROPAGATED — the caller must surface a retriable error and must not
   * report a sign-out, because the session is still live.
   */
  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout', { auth: false });
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
    const response = await this.rawRequest(method, path, opts.body);
    // An expired access cookie is denied by the authorizer as a 403; a 401 is handled
    // the same. Refresh once and retry only for authenticated requests.
    if ((response.status === 401 || response.status === 403) && opts.auth) {
      const refreshed = await this.refreshTokens();
      if (refreshed) {
        // Retry exactly once with the rotated cookies — no loop on a second failure.
        return this.parse<T>(await this.rawRequest(method, path, opts.body));
      }
      this.onAuthLost?.();
    }
    return this.parse<T>(response);
  }

  private async rawRequest(method: Method, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      // The session cookies are httpOnly; the browser attaches them here.
      credentials: 'include',
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
    // The refresh token rides in the httpOnly cookie — no body. Any failure (non-2xx
    // OR a thrown network error) resolves to `false` so the caller runs onAuthLost;
    // the server has already cleared both cookies on the non-2xx path.
    try {
      const response = await this.rawRequest('POST', '/auth/refresh', undefined);
      return response.ok;
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
