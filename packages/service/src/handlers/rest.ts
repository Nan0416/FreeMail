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
import { AuthService } from '../auth/service.js';
import { AuthError, authErrors } from '../auth/errors.js';
import { DdbAuthRepo } from '../data/ddb-auth-repo.js';
import { DdbApiKeysRepo } from '../data/ddb-keys-repo.js';
import { DdbEmailsRepo } from '../data/ddb-emails-repo.js';
import { ApiKeyService } from '../keys/service.js';
import { EmailService } from '../email/service.js';
import { EmailError, emailErrors } from '../email/errors.js';
import { SesV2Sender } from '../email/ses-sender.js';
import { getSigningKey } from '../config/signing-key.js';
import { requireAccessScheme, subjectFromContext } from './request-context.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

// Reused across warm invocations; the signing key is cached inside getSigningKey.
let repo: DdbAuthRepo | undefined;
let keysRepo: DdbApiKeysRepo | undefined;
let emailsRepo: DdbEmailsRepo | undefined;
let sesSender: SesV2Sender | undefined;

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

function getEmailService(): EmailService {
  const emailDomain = process.env.EMAIL_DOMAIN;
  if (!emailDomain) {
    throw new Error('EMAIL_DOMAIN is not set.');
  }
  const tableName = process.env.EMAILS_TABLE;
  if (!tableName) {
    throw new Error('EMAILS_TABLE is not set.');
  }
  emailsRepo ??= new DdbEmailsRepo(tableName);
  sesSender ??= new SesV2Sender({ configurationSetName: process.env.SES_CONFIGURATION_SET });
  return new EmailService({ ses: sesSender, emails: emailsRepo, emailDomain });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const service = new AuthService({ repo: getRepo(), signingKey: await getSigningKey() });
    switch (event.routeKey) {
      case 'POST /auth/set-password':
        await service.setPassword(requireString(parseBody(event), 'password'));
        return noContent();
      case 'POST /auth/login':
        return json(200, await service.login(requireString(parseBody(event), 'password')));
      case 'POST /auth/refresh':
        return json(200, await service.refresh(requireString(parseBody(event), 'refreshToken')));
      case 'POST /auth/logout':
        await service.logout(requireString(parseBody(event), 'refreshToken'));
        return noContent();
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
        return json(200, await getEmailService().send(parseSendEmailBody(parseBody(event))));
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
 * Coerce untrusted JSON into a {@link SendEmailRequest} shape (types only). The
 * semantic rules — sender domain, recipient presence, caps — live in
 * {@link EmailService} so REST and the MCP tool share them.
 */
function parseSendEmailBody(body: Record<string, unknown>): SendEmailRequest {
  const request: SendEmailRequest = { from: requireString(body, 'from') };
  const fromName = optionalString(body, 'fromName');
  if (fromName !== undefined) {
    request.fromName = fromName;
  }
  const subject = optionalString(body, 'subject');
  if (subject !== undefined) {
    request.subject = subject;
  }
  const text = optionalString(body, 'text');
  if (text !== undefined) {
    request.text = text;
  }
  const html = optionalString(body, 'html');
  if (html !== undefined) {
    request.html = html;
  }
  const to = optionalStringArray(body, 'to');
  if (to !== undefined) {
    request.to = to;
  }
  const cc = optionalStringArray(body, 'cc');
  if (cc !== undefined) {
    request.cc = cc;
  }
  const bcc = optionalStringArray(body, 'bcc');
  if (bcc !== undefined) {
    request.bcc = bcc;
  }
  const attachments = optionalAttachments(body);
  if (attachments !== undefined) {
    request.attachments = attachments;
  }
  return request;
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
