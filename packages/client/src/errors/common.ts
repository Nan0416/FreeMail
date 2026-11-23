/**
 * A non-2xx response from the FreeMail API. FreeMail's own errors carry a code (`invalid_request`, `invalid_sender`,
 * `not_found`, ...); API Gateway's refusals, such as a 403 for a missing or revoked API key, do not.
 */
export class FreeMailApiError extends Error {
  /** The call, such as `POST /emails`. */
  readonly request: string;
  readonly status: number;
  /** FreeMail's error code; null when the body carried none. */
  readonly code: string | null;

  constructor(request: string, status: number, code: string | null, detail: string) {
    super(`FreeMail ${request} returned HTTP ${status}${code === null ? '' : ` ${code}`}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'FreeMailApiError';
    this.request = request;
    this.status = status;
    this.code = code;
  }
}

/** A 401 or 403: the API key is missing, wrong or revoked. */
export class FreeMailAuthError extends FreeMailApiError {
  constructor(request: string, status: number, code: string | null, detail: string) {
    super(request, status, code, detail);
    this.name = 'FreeMailAuthError';
  }
}

/** `getEmail` for an id the deployment does not hold, or one that is not an id it issued. */
export class FreeMailEmailNotFoundError extends FreeMailApiError {
  constructor(request: string, status: number, code: string | null, detail: string) {
    super(request, status, code, detail);
    this.name = 'FreeMailEmailNotFoundError';
  }
}

/** The error class for each FreeMail error code a call's caller handles differently. */
export type FreeMailApiErrorClasses = Readonly<Partial<Record<string, typeof FreeMailApiError>>>;

/** Reads FreeMail's `{ error, message }` body, or API Gateway's `{ message }`, into the matching error class. */
export function createFreeMailApiError(request: string, status: number, rawBody: string, errorClasses: FreeMailApiErrorClasses = {}): FreeMailApiError {
  const body = readErrorBody(rawBody);
  const ErrorClass = (body.code === null ? undefined : errorClasses[body.code]) ?? (status === 401 || status === 403 ? FreeMailAuthError : FreeMailApiError);
  return new ErrorClass(request, status, body.code, body.detail);
}

interface ErrorBody {
  readonly code: string | null;
  readonly detail: string;
}

function readErrorBody(rawBody: string): ErrorBody {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { code: null, detail: rawBody.slice(0, 300) };
  }
  if (typeof body !== 'object' || body === null) {
    return { code: null, detail: rawBody.slice(0, 300) };
  }
  const fields = body as { readonly error?: unknown; readonly message?: unknown };
  return {
    code: typeof fields.error === 'string' ? fields.error : null,
    detail: typeof fields.message === 'string' ? fields.message : '',
  };
}

/** A 2xx response whose body is not what the call returns. */
export class FreeMailResponseValidationError extends Error {
  readonly request: string;
  readonly details: string;

  constructor(request: string, details: string) {
    super(`FreeMail ${request} response does not match the expected shape: ${details}`);
    this.name = 'FreeMailResponseValidationError';
    this.request = request;
    this.details = details;
  }
}

/** S3 refused the attachment's bytes: the upload URL expired, or the bytes are not the declared size. */
export class FreeMailUploadError extends Error {
  readonly status: number;
  /** S3's error code, such as `SignatureDoesNotMatch` or `AccessDenied`; null when the body carried none. */
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`The attachment upload returned HTTP ${status}${code === null ? '' : ` ${code}`}`);
    this.name = 'FreeMailUploadError';
    this.status = status;
    this.code = code;
  }
}

/** A message body that is not an email-received notification. */
export class FreeMailNotificationValidationError extends Error {
  readonly details: string;

  constructor(details: string) {
    super(`The message is not a FreeMail email-received notification: ${details}`);
    this.name = 'FreeMailNotificationValidationError';
    this.details = details;
  }
}
