/**
 * Request-shape gate for cookie-authenticated mutations (#47, Layer 3 of the CORS/CSRF
 * model).
 *
 * `SameSite=Strict` stops a FOREIGN site from making the session cookie ride, but it does
 * nothing against a SAME-SITE SIBLING (`evil.example.com` → `api.example.com`): that
 * request is same-site, so the cookie is carried. The defense is to make every
 * cookie-authenticated mutation a NON-SIMPLE request, which forces the browser to
 * preflight it — and the API's exact-single-origin CORS policy then refuses that
 * preflight for any origin but the app's. Requiring `application/json` is what makes a
 * request non-simple; it also rejects the plain `<form>`-POST path, which never
 * preflights at all, at the handler before any side effect.
 *
 * This is a request-SHAPE rule, uniform regardless of `Origin`. It is NOT origin
 * checking and NOT authorization — the Lambda authorizer remains the sole authorization
 * boundary, so a no-`Origin` agent call with `x-api-key` passes untouched (the API is
 * JSON-only, so agents already send this content type).
 */

/** The one media type FreeMail's bodyful routes accept. */
const REQUIRED_MEDIA_TYPE = 'application/json';

/**
 * True when `header` declares `application/json`.
 *
 * Parses rather than string-compares: the media type is matched case-insensitively and
 * valid parameters are tolerated (`application/json; charset=utf-8`), because a raw
 * equality check would both reject a legitimate charset parameter and risk accepting a
 * crafted lookalike such as `application/json-patch+json`.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  // Everything before the first `;` is the media type; parameters follow and are ignored.
  const mediaType = header.split(';')[0]?.trim().toLowerCase();
  return mediaType === REQUIRED_MEDIA_TYPE;
}

/**
 * Read `content-type` from an API Gateway v2 header bag. HTTP header names are
 * case-insensitive and API Gateway lowercases them, but scan defensively rather than
 * assume — a missed header here would reject a legitimate request.
 */
export function readContentType(
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') {
      return value;
    }
  }
  return undefined;
}

/** True when the request carries a `Content-Type` of `application/json`. */
export function hasJsonContentType(
  headers: Record<string, string | undefined> | undefined,
): boolean {
  return isJsonContentType(readContentType(headers));
}
