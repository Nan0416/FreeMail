/**
 * REST API Lambda for the React app. One HTTP API (payload v2) integration fronts
 * every REST route via an internal router — a single-tenant, low-traffic app does
 * not need a Lambda per route. Auth routes are public (you have no token yet);
 * `GET /me` sits behind the Lambda authorizer and echoes the authenticated subject.
 *
 * `/keys` manages agent API keys (behind the authorizer); #6 send adds more routes
 * here, and #7's MCP server is a separate handler on the same HTTP API.
 */
import type { AuthErrorBody, ListApiKeysResponse, SessionResponse } from '@freemail/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthService } from '../auth/service.js';
import { AuthError, authErrors } from '../auth/errors.js';
import { DdbAuthRepo } from '../data/ddb-auth-repo.js';
import { DdbApiKeysRepo } from '../data/ddb-keys-repo.js';
import { ApiKeyService } from '../keys/service.js';
import { getSigningKey } from '../config/signing-key.js';
import { requireAccessScheme, subjectFromContext } from './request-context.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

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

function toErrorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof AuthError) {
    const headers =
      error.retryAfterSeconds !== undefined
        ? { ...JSON_HEADERS, 'retry-after': String(error.retryAfterSeconds) }
        : JSON_HEADERS;
    return {
      statusCode: error.status,
      headers,
      body: JSON.stringify({ error: error.code, message: error.message } satisfies AuthErrorBody),
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
