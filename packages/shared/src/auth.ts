/**
 * Auth wire contract shared by the service (which enforces it) and the React app
 * / CLI (which call it). Single-tenant: there is no username — the whole system
 * is gated by one password that issues short-lived access tokens plus rotating
 * refresh tokens.
 */

/** Minimum length for the single account password. Enforced server-side; the app pre-checks with the same rule. */
export const MIN_PASSWORD_LENGTH = 12;

/** Access-token lifetime. Short, because it is stateless — revocation happens by rotating the refresh token, not the access token. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh-token lifetime. Rotated on every use; the row in DDB carries this as its TTL. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AuthErrorCode =
  | 'invalid_request'
  | 'weak_password'
  | 'password_already_set'
  | 'password_not_set'
  | 'invalid_credentials'
  | 'account_locked'
  | 'invalid_token';

export interface SetPasswordRequest {
  password: string;
}

export interface LoginRequest {
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  refreshToken: string;
}

/** A freshly minted access + refresh pair. `expiresIn` is the access token's lifetime in seconds. */
export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResponse = TokenPair;
export type RefreshResponse = TokenPair;

export interface SessionResponse {
  /** The authenticated subject — always the single-tenant owner. */
  subject: string;
}

export interface AuthErrorBody {
  error: AuthErrorCode;
  message: string;
}

/**
 * The single shared password policy so the app and the server never disagree on
 * what "too weak" means. Returns the failing code, or `null` when acceptable.
 * Length-only for v1 (a single memorized secret, not an account farm); composition
 * rules add friction without much brute-force benefit here.
 */
export function passwordPolicyError(password: string): AuthErrorCode | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return 'weak_password';
  }
  return null;
}
