/**
 * REST API Lambda for the React app. One HTTP API (payload v2) integration fronts
 * every REST route via an internal router — a single-tenant, low-traffic app does
 * not need a Lambda per route. Auth routes are public (you have no token yet);
 * `GET /me` sits behind the Lambda authorizer and echoes the authenticated subject.
 *
 * `/keys` manages agent API keys (behind the authorizer); #6 send adds more routes
 * here, and #7's MCP server is a separate handler on the same HTTP API.
 */
import type {
  AuthErrorBody,
  EmailAttachment,
  ListApiKeysResponse,
  SendEmailRequest,
  SessionResponse,
} from '@freemail/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthService, OWNER_SUBJECT } from '../auth/service.js';
import { AuthError, authErrors } from '../auth/errors.js';
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  readCookie,
  sessionCookies,
} from '../auth/cookies.js';
import { DdbAuthRepo } from '../data/ddb-auth-repo.js';
import { DdbApiKeysRepo } from '../data/ddb-keys-repo.js';
import { ApiKeyService } from '../keys/service.js';
import { createEmailServiceFromEnv } from '../email/create-email-service.js';
import { createEmailReadServiceFromEnv } from '../email/create-read-service.js';
import { createDownloadServiceFromEnv } from '../email/create-download-service.js';
import { parseListEmailsQuery } from '../email/list-query.js';
import type { ListEmailsQuery } from '../email/read-service.js';
import { EmailError, emailErrors } from '../email/errors.js';
import { getSigningKey } from '../config/signing-key.js';
import { requireAccessScheme, subjectFromContext } from './request-context.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
// Auth responses carry Set-Cookie, so they must never be cached by any layer
// (a cached session cookie served to another viewer is the nightmare case).
const NO_STORE_HEADERS = { 'cache-control': 'no-store' };

// Reused across warm invocations; the signing key is cached inside getSigningKey.
let repo: DdbAuthRepo | undefined;
let keysRepo: DdbApiKeysRepo | undefined;

function getRepo(): DdbAuthRepo {
  const tableName = process.env.AUTH_TABLE;
  if (!tableName) {
    throw new Error('AUTH_TABLE is not set.');
  }
  repo ??= new DdbAuthRepo(tableName);
  return repo;
}

function getKeyService(): ApiKeyService {
  const tableName = process.env.API_KEYS_TABLE;
  if (!tableName) {
    throw new Error('API_KEYS_TABLE is not set.');
  }
  keysRepo ??= new DdbApiKeysRepo(tableName);
  return new ApiKeyService({ repo: keysRepo });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const service = new AuthService({ repo: getRepo(), signingKey: await getSigningKey() });
    switch (event.routeKey) {
      case 'POST /auth/set-password':
        await service.setPassword(requireString(parseBody(event), 'password'));
        return authNoContent();
      case 'POST /auth/login': {
        const pair = await service.login(requireString(parseBody(event), 'password'));
        // Tokens ride in httpOnly cookies; the body only echoes the session subject.
        return authJson(
          200,
          { subject: OWNER_SUBJECT } satisfies SessionResponse,
          sessionCookies(pair.accessToken, pair.refreshToken),
        );
      }
      case 'POST /auth/refresh':
        // Awaited so an unexpected (non-AuthError) rejection is normalized by the
        // outer catch (clean 500, no cookie logged) rather than escaping the handler.
        return await handleRefresh(event, service);
      case 'POST /auth/logout':
        return await handleLogout(event, service);
      case 'GET /me':
        return json(200, { subject: subjectFromContext(event) } satisfies SessionResponse);
      case 'POST /keys':
        requireAccessScheme(event);
        return json(
          201,
          await getKeyService().create(optionalString(parseOptionalBody(event), 'name')),
        );
      case 'GET /keys':
        requireAccessScheme(event);
        return json(200, { keys: await getKeyService().list() } satisfies ListApiKeysResponse);
      case 'DELETE /keys/{id}':
        requireAccessScheme(event);
        await getKeyService().revoke(requirePathParam(event, 'id'));
        return noContent();
      case 'POST /emails':
        // Dual-scheme by design: unlike /keys (access-only), a Bearer human AND an
        // x-api-key agent may send — so NO requireAccessScheme here.
        return json(
          200,
          await createEmailServiceFromEnv().send(parseSendEmailBody(parseBody(event))),
        );
      case 'GET /emails':
        // Reads are the human/web surface (access-token only); the agent read path is
        // #13's MCP tools over the same read service.
        requireAccessScheme(event);
        return json(200, await createEmailReadServiceFromEnv().listEmails(parseListQuery(event)));
      case 'GET /emails/{id}':
        requireAccessScheme(event);
        return json(
          200,
          await createEmailReadServiceFromEnv().getEmail(requirePathParam(event, 'id')),
        );
      case 'GET /emails/{id}/attachments/{attachmentId}':
        requireAccessScheme(event);
        return json(
          200,
          await createEmailReadServiceFromEnv().getAttachmentUrl(
            requirePathParam(event, 'id'),
            requirePathParam(event, 'attachmentId'),
          ),
        );
      case 'GET /d/{token}':
        // PUBLIC (no authorizer): the token is the sole capability. Resolves to a 302 to a
        // short-lived presigned GET, or a uniform 404 for any invalid/expired/revoked token.
        return await handleDownload(event);
      default:
        return json(404, {
          error: 'invalid_request',
          message: 'Not found.',
        } satisfies AuthErrorBody);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
};

/**
 * Rotate the session from the refresh cookie. The refresh credential is read ONLY
 * from the `__Host-fm_refresh` cookie — never a body or query param — and every
 * failure path (absent, duplicate/injected, malformed, expired, or replayed) clears
 * BOTH cookies and returns the auth error, so a failed refresh can never leave a
 * partial session or emit a refreshed credential.
 */
async function handleRefresh(
  event: APIGatewayProxyEventV2,
  service: AuthService,
): Promise<APIGatewayProxyStructuredResultV2> {
  const cookie = readCookie(event.cookies, REFRESH_COOKIE);
  // A duplicate is treated exactly like an absent cookie — rejected, never guessed.
  const refreshToken = typeof cookie === 'string' ? cookie : null;
  if (refreshToken === null) {
    return refreshFailure(authErrors.invalidToken());
  }
  try {
    const pair = await service.refresh(refreshToken);
    return authNoContent(sessionCookies(pair.accessToken, pair.refreshToken));
  } catch (error) {
    if (error instanceof AuthError) {
      return refreshFailure(error);
    }
    throw error;
  }
}

/**
 * Server-side revoke of the presented refresh token, then always clear both cookies.
 * Since the tokens are httpOnly, ONLY this response's `Set-Cookie` can clear the
 * browser copy — so both clears are emitted on EVERY path, including when revocation
 * throws. A revocation failure returns a non-2xx (the client must not report a clean
 * sign-out when the server session may still be live) but still attaches the clears
 * to best-effort remove the browser copy. The refresh credential is read only from
 * the cookie, never a body/query.
 */
async function handleLogout(
  event: APIGatewayProxyEventV2,
  service: AuthService,
): Promise<APIGatewayProxyStructuredResultV2> {
  const cookie = readCookie(event.cookies, REFRESH_COOKIE);
  try {
    if (typeof cookie === 'string') {
      await service.logout(cookie);
    }
  } catch {
    // Revocation failed (e.g. a transient store error): still clear the browser copy,
    // but signal non-2xx so the client surfaces a retriable failure instead of a lie.
    return {
      statusCode: 500,
      headers: { ...JSON_HEADERS, ...NO_STORE_HEADERS },
      cookies: clearSessionCookies(),
      body: JSON.stringify({
        error: 'invalid_request',
        message: 'Sign-out could not complete. Please retry.',
      }),
    };
  }
  return authNoContent(clearSessionCookies());
}

/** An auth error response that also clears both session cookies (no-store, never cached). */
function refreshFailure(error: AuthError): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: error.status,
    headers: { ...JSON_HEADERS, ...NO_STORE_HEADERS },
    cookies: clearSessionCookies(),
    body: JSON.stringify({ error: error.code, message: error.message }),
  };
}

/**
 * A public, human-facing HTML page for any failed download. Uniform for every cause
 * (unknown / malformed / expired / revoked / exhausted) — no oracle, no reflected input.
 */
const DOWNLOAD_NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Link unavailable</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222">' +
  '<h1>This link is no longer available</h1>' +
  '<p>The download link has expired or is no longer valid.</p></body></html>';

/**
 * Resolve a `GET /d/{token}` request. The whole path stays in HTML space — a valid token
 * yields a `302` to a freshly minted, short-lived presigned GET (the S3 bucket/key are
 * never disclosed), and every failure yields the same `404` page. Both responses are
 * `no-store` so no cache serves a stale redirect or a since-revoked link.
 */
async function handleDownload(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const token = event.pathParameters?.token;
  if (typeof token !== 'string' || token.length === 0) {
    return downloadNotFound();
  }
  const result = await createDownloadServiceFromEnv().resolve(token);
  return result ? downloadRedirect(result.url) : downloadNotFound();
}

function downloadRedirect(url: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 302, headers: { location: url, 'cache-control': 'no-store' } };
}

function downloadNotFound(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: DOWNLOAD_NOT_FOUND_HTML,
  };
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) {
    throw authErrors.invalidRequest('Request body is required.');
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw authErrors.invalidRequest('Request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw authErrors.invalidRequest('Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw authErrors.invalidRequest(`"${field}" is required.`);
  }
  return value;
}

/** Like {@link parseBody} but tolerates an absent body (routes where every field is optional). */
function parseOptionalBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  return event.body ? parseBody(event) : {};
}

/** An optional string field: undefined when absent, but a wrong type is still a 400. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw authErrors.invalidRequest(`"${field}" must be a string.`);
  }
  return value;
}

function requirePathParam(event: APIGatewayProxyEventV2, name: string): string {
  const value = event.pathParameters?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw authErrors.invalidRequest(`Path parameter "${name}" is required.`);
  }
  return value;
}

/**
 * Parse `GET /emails` query params via the shared {@link parseListEmailsQuery} — the
 * same validation/defaulting/clamping the MCP `list_emails` tool uses, so REST and MCP
 * can never drift.
 */
function parseListQuery(event: APIGatewayProxyEventV2): ListEmailsQuery {
  const qs = event.queryStringParameters ?? {};
  return parseListEmailsQuery({ direction: qs.direction, limit: qs.limit, cursor: qs.cursor });
}

/**
 * Coerce untrusted JSON into a {@link SendEmailRequest} shape (types only). The
 * semantic rules — sender domain, recipient presence, caps — live in
 * {@link EmailService} so REST and the MCP tool share them.
 */
function parseSendEmailBody(body: Record<string, unknown>): SendEmailRequest {
  // `from` is validated first so a missing sender is reported before any other field error.
  const from = requireString(body, 'from');
  const fromName = optionalString(body, 'fromName');
  const subject = optionalString(body, 'subject');
  const text = optionalString(body, 'text');
  const html = optionalString(body, 'html');
  const to = optionalStringArray(body, 'to');
  const cc = optionalStringArray(body, 'cc');
  const bcc = optionalStringArray(body, 'bcc');
  const attachments = optionalAttachments(body);
  return {
    from,
    ...(fromName !== undefined ? { fromName } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cc !== undefined ? { cc } : {}),
    ...(bcc !== undefined ? { bcc } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw emailErrors.invalidRequest(`"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function optionalAttachments(body: Record<string, unknown>): EmailAttachment[] | undefined {
  const value = body.attachments;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw emailErrors.invalidRequest('"attachments" must be an array.');
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw emailErrors.invalidRequest(`"attachments[${index}]" must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const { filename, contentType, contentBase64 } = record;
    if (
      typeof filename !== 'string' ||
      typeof contentType !== 'string' ||
      typeof contentBase64 !== 'string'
    ) {
      throw emailErrors.invalidRequest(
        `"attachments[${index}]" must have string filename, contentType, and contentBase64.`,
      );
    }
    return { filename, contentType, contentBase64 };
  });
}

function toErrorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof AuthError || error instanceof EmailError) {
    const retryAfter = error instanceof AuthError ? error.retryAfterSeconds : undefined;
    const headers =
      retryAfter !== undefined
        ? { ...JSON_HEADERS, 'retry-after': String(retryAfter) }
        : JSON_HEADERS;
    return {
      statusCode: error.status,
      headers,
      body: JSON.stringify({ error: error.code, message: error.message }),
    };
  }
  console.error('Unhandled error in REST handler', error);
  return json(500, {
    error: 'invalid_request',
    message: 'Internal error.',
  } satisfies AuthErrorBody);
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204 };
}

/** A JSON auth response (`no-store`) that optionally sets session cookies. */
function authJson(
  statusCode: number,
  body: unknown,
  cookies?: string[],
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...NO_STORE_HEADERS },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

/** A 204 auth response (`no-store`) that optionally sets/clears session cookies. */
function authNoContent(cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, headers: { ...NO_STORE_HEADERS }, ...(cookies ? { cookies } : {}) };
}
