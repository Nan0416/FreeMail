import type { AuthErrorCode, EmailErrorCode } from '@freemail/shared';
/**
 * Every domain error the service can raise, in one module — conduit keeps its error
 * hierarchy in `utils/errors.ts` for the same reason: the middleware error handler has to
 * discriminate over all of them, so scattering them across domain folders only made that
 * import list longer.
 *
 * Two families, deliberately NOT merged into a single base class:
 *
 *  - `AuthError` / `EmailError` are WIRE errors. Each carries the error code the client
 *    sees plus the HTTP status, so the service that knows why something failed decides the
 *    status, and `middleware/error-handler.ts` only renders it. Their codes come from
 *    `@freemail/shared` and are part of the API contract the SPA reads.
 *  - `InboundParseError` / `InboundLimitError` never reach a client at all. Inbound mail is
 *    processed off an S3 event, so these exist to mark a failure as HANDLED — attacker
 *    controllable, quarantine it and return successfully — versus everything else, which
 *    propagates so the async invocation retries and eventually DLQs.
 */

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
  invalidCredentials: () => new AuthError('invalid_credentials', 401, 'Incorrect password.'),
  accountLocked: (retryAfterSeconds: number) =>
    new AuthError(
      'account_locked',
      429,
      'Too many failed attempts. Try again later.',
      retryAfterSeconds,
    ),
  invalidToken: () => new AuthError('invalid_token', 401, 'Invalid or expired token.'),
  unsupportedMediaType: () =>
    new AuthError(
      'unsupported_media_type',
      415,
      'Content-Type must be application/json for this request.',
    ),
  forbidden: (message = 'Forbidden.') => new AuthError('forbidden', 403, message),
};

/**
 * A send-email domain error carrying the wire code + HTTP status, mirroring
 * {@link AuthError}. Throwing these from the service keeps the
 * "why it's a 400" decision next to the validation, not in the router — the
 * sender-domain and payload checks all surface as explicit 400s, never a 500.
 */
export class EmailError extends Error {
  readonly code: EmailErrorCode;
  readonly status: number;

  constructor(code: EmailErrorCode, status: number, message: string) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
    this.status = status;
  }
}

export const emailErrors = {
  invalidRequest: (message: string) => new EmailError('invalid_request', 400, message),
  invalidSender: (message: string) => new EmailError('invalid_sender', 400, message),
  /**
   * The requested message / attachment does not exist. Also used for a malformed
   * message handle — a bad handle is indistinguishable from a missing row on purpose,
   * so nothing about the id space or storage layout leaks.
   */
  notFound: (message: string) => new EmailError('not_found', 404, message),
};

/**
 * HANDLED inbound-processing failures — the two cases that must NOT be retried.
 * A malformed message or a limit breach is attacker-controllable, so it produces a
 * bounded quarantined/parse-status row and a successful return, never an infinite
 * S3 retry. Every OTHER error (S3/DDB throttle or outage) is left to propagate so
 * the async invocation retries and eventually lands in the DLQ.
 */

/** The raw MIME could not be parsed (malformed / truncated / bad encoding). */
export class InboundParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundParseError';
  }
}

/** A resource limit was exceeded while parsing (size / count / parts). */
export class InboundLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundLimitError';
  }
}

/** True for the two handled classes — used by the processor to choose quarantine-vs-retry. */
export function isHandledInboundError(err: unknown): err is InboundParseError | InboundLimitError {
  return err instanceof InboundParseError || err instanceof InboundLimitError;
}
