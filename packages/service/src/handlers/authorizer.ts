/**
 * Lambda REQUEST authorizer for the HTTP API (SIMPLE response format).
 *
 * Dual-scheme by design (`DESIGN.md § Auth`: "a Lambda authorizer covers both
 * REST access-tokens and MCP API-keys"): a `Bearer` access JWT authorizes REST
 * routes, and an `x-api-key` header is the seam for the MCP server's agent keys.
 * Because either header may be the credential, the CDK authorizer runs with no
 * fixed identity source and caching off, so this function always sees the full
 * request and picks the scheme.
 *
 * #4 implements the access-token branch; the API-key branch is validated in #5.
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { getSigningKey } from '../config/signing-key.js';
import { verifyAccessToken } from '../auth/jwt.js';

interface AuthorizerContext {
  sub: string;
  scheme: 'access';
}

type Result = APIGatewaySimpleAuthorizerWithContextResult<AuthorizerContext>;

const DENY: APIGatewaySimpleAuthorizerWithContextResult<Record<string, never>> = {
  isAuthorized: false,
  context: {},
};

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<Result | typeof DENY> => {
  const headers = event.headers ?? {};
  const bearer = extractBearer(headers.authorization ?? headers.Authorization);

  if (bearer) {
    const result = await verifyAccessToken(
      bearer,
      await getSigningKey(),
      Math.floor(Date.now() / 1000),
    );
    if (result.valid) {
      return { isAuthorized: true, context: { sub: result.claims.sub, scheme: 'access' } };
    }
    return DENY;
  }

  // Seam for #5: MCP agents present an `x-api-key`. Until key validation lands,
  // an API key never authorizes — we deny rather than silently allow.
  if (headers['x-api-key']) {
    return DENY;
  }

  return DENY;
};

function extractBearer(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token.trim();
}
