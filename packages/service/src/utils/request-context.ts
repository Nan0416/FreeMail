/**
 * Pure readers over the Lambda authorizer's SIMPLE-response context. Kept framework-free
 * (they only read the event, never an Express request) so the authorization boundary is
 * unit-testable without AWS.
 *
 * Both entry points now reach them the same way — through `middleware/auth-middleware.ts`,
 * which attaches the result to `req.authContext` once per request. The per-route guards
 * (`requireAccessScheme`, `requireAuthenticated`) read that attached context rather than
 * re-deriving it from the event, which is why nothing outside the middleware needs a
 * throwing `subjectFromContext` variant any more.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

interface AuthorizerLambdaContext {
  readonly sub?: unknown;
  readonly scheme?: unknown;
}

function authorizerContext(event: APIGatewayProxyEventV2): AuthorizerLambdaContext {
  // `requestContext` is optional-chained rather than indexed: these readers now run on
  // EVERY request, because `authMiddleware` attaches context for the whole app including
  // the public routes. A reader on the authorization path must degrade to "no context"
  // rather than throw a TypeError the error handler would then have to report as a 500.
  const requestContext = event.requestContext as unknown as
    { authorizer?: { lambda?: AuthorizerLambdaContext } } | undefined;
  return requestContext?.authorizer?.lambda ?? {};
}

/**
 * The authenticated subject the authorizer attached, or undefined when there is none.
 * Undefined is a normal outcome, not a failure: the public routes (`/auth/*`,
 * `GET /d/{token}`) are not behind the authorizer at all.
 */
export function optionalSubjectFromContext(event: APIGatewayProxyEventV2): string | undefined {
  const subject = authorizerContext(event).sub;
  return typeof subject === 'string' ? subject : undefined;
}

/** The credential scheme the authorizer used (`access` | `apiKey`), or undefined if absent. */
export function schemeFromContext(event: APIGatewayProxyEventV2): string | undefined {
  const scheme = authorizerContext(event).scheme;
  return typeof scheme === 'string' ? scheme : undefined;
}
