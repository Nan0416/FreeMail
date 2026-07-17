import type { AuthErrorCode } from '@freemail/shared';

/**
 * A domain error carrying the wire error code and the HTTP status the REST
 * handler should map it to. Throwing these from the service keeps status
 * decisions next to the logic that knows what went wrong, not in the router.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  /** Optional `Retry-After` hint (seconds), set when a lockout is in effect. */
  readonly retryAfterSeconds?: number;

  constructor(code: AuthErrorCode, status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export const authErrors = {
  invalidRequest: (message = 'Invalid request.') => new AuthError('invalid_request', 400, message),
  weakPassword: () =>
    new AuthError('weak_password', 400, 'Password does not meet the minimum length requirement.'),
  passwordAlreadySet: () =>
    new AuthError('password_already_set', 409, 'A password has already been set.'),
  passwordNotSet: () => new AuthError('password_not_set', 409, 'No password has been set yet.'),
  invalidCredentials: () => new AuthError('invalid_credentials', 401, 'Incorrect password.'),
  accountLocked: (retryAfterSeconds: number) =>
    new AuthError(
      'account_locked',
      429,
      'Too many failed attempts. Try again later.',
      retryAfterSeconds,
    ),
  invalidToken: () => new AuthError('invalid_token', 401, 'Invalid or expired token.'),
};
