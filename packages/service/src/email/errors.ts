import type { EmailErrorCode } from '@freemail/shared';

/**
 * A send-email domain error carrying the wire code + HTTP status, mirroring
 * {@link ../auth/errors.AuthError}. Throwing these from the service keeps the
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
