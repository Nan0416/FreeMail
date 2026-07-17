/**
 * Pure readers over the Lambda authorizer's SIMPLE-response context, plus the
 * per-route scheme guard. Kept framework-free (they only read the event) so the
 * authorization boundary is unit-testable without AWS.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { authErrors } from '../auth/errors.js';

interface AuthorizerLambdaContext {
  sub?: unknown;
  scheme?: unknown;
}

function authorizerContext(event: APIGatewayProxyEventV2): AuthorizerLambdaContext {
  const requestContext = event.requestContext as unknown as {
    authorizer?: { lambda?: AuthorizerLambdaContext };
  };
  return requestContext.authorizer?.lambda ?? {};
}

/**
 * The authenticated subject the authorizer attached. The authorizer guards these
 * routes, so this should always be present; fail loud rather than emit an empty
 * subject if the wiring ever regresses.
 */
export function subjectFromContext(event: APIGatewayProxyEventV2): string {
  const subject = authorizerContext(event).sub;
  if (typeof subject !== 'string') {
    throw authErrors.invalidToken();
  }
  return subject;
}

/** The credential scheme the authorizer used (`access` | `apiKey`), or undefined if absent. */
export function schemeFromContext(event: APIGatewayProxyEventV2): string | undefined {
  const scheme = authorizerContext(event).scheme;
  return typeof scheme === 'string' ? scheme : undefined;
}

/**
 * Guard for key-management routes: only a Bearer access token (the human, via the
 * app) may mint or manage API keys. An `x-api-key`-authenticated caller is
 * authenticated but must NOT be able to escalate to managing the account's key
 * set — so anything other than the `access` scheme is forbidden. Fails closed on
 * a missing scheme.
 */
export function requireAccessScheme(event: APIGatewayProxyEventV2): void {
  if (schemeFromContext(event) !== 'access') {
    throw authErrors.forbidden('API keys cannot manage API keys.');
  }
}
