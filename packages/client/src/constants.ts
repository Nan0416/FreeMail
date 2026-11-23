/** The default timeout for an API call. API Gateway gives up on a request after 30 seconds anyway. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The default timeout for PUTting an attachment's bytes: the upload URL's own lifetime. */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** The longest timeout a timer can hold (about 24.8 days); a longer one would fire at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
