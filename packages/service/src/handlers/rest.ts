/**
 * REST API Lambda for the React app. One HTTP API (payload v2) integration fronts
 * every REST route via an internal router — a single-tenant, low-traffic app does
 * not need a Lambda per route. Auth routes are public (you have no token yet);
 * `GET /me` sits behind the Lambda authorizer and echoes the authenticated subject.
 *
 * Later slices (#5 keys, #6 send) add routes here; #7's MCP server is a separate
 * handler on the same HTTP API.
 */
import type { AuthErrorBody, SessionResponse } from '@freemail/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AuthService } from '../auth/service.js';
import { AuthError, authErrors } from '../auth/errors.js';
import { DdbAuthRepo } from '../data/ddb-auth-repo.js';
import { getSigningKey } from '../config/signing-key.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

// Reused across warm invocations; the signing key is cached inside getSigningKey.
let repo: DdbAuthRepo | undefined;

function getRepo(): DdbAuthRepo {
  const tableName = process.env.AUTH_TABLE;
  if (!tableName) {
    throw new Error('AUTH_TABLE is not set.');
  }
  repo ??= new DdbAuthRepo(tableName);
  return repo;
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

function subjectFromContext(event: APIGatewayProxyEventV2): string {
  const requestContext = event.requestContext as unknown as {
    authorizer?: { lambda?: Record<string, unknown> };
  };
  const subject = requestContext.authorizer?.lambda?.sub;
  // The authorizer guards this route, so this should always be present; fail
  // loud rather than emit an empty subject if the wiring ever regresses.
  if (typeof subject !== 'string') {
    throw authErrors.invalidToken();
  }
  return subject;
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
