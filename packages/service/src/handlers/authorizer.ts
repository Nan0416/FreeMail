/**
 * Lambda REQUEST authorizer for the HTTP API (SIMPLE response format).
 *
 * Dual-scheme by design (`DESIGN.md § Auth`: "a Lambda authorizer covers both
 * REST access-tokens and MCP API-keys"): a `Bearer` access JWT authorizes REST
 * routes, and an `x-api-key` header authorizes the MCP server's agent keys,
 * validated against the hashed-keys table. Because either header may be the
 * credential, the CDK authorizer runs with no fixed identity source and caching
 * off, so this function always sees the full request and picks the scheme.
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { getSigningKey } from '../config/signing-key.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { OWNER_SUBJECT } from '../auth/service.js';
import { DdbApiKeysRepo } from '../data/ddb-keys-repo.js';
import { ApiKeyService } from '../keys/service.js';

interface AuthorizerContext {
  sub: string;
  scheme: 'access' | 'apiKey';
}

// Reused across warm invocations. Verification is a table read; no signing key needed.
let apiKeyService: ApiKeyService | undefined;

function getApiKeyService(): ApiKeyService {
  const tableName = process.env.API_KEYS_TABLE;
  if (!tableName) {
    throw new Error('API_KEYS_TABLE is not set.');
  }
  apiKeyService ??= new ApiKeyService({ repo: new DdbApiKeysRepo(tableName) });
  return apiKeyService;
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

  // MCP agents present an `x-api-key`. Validate it against the hashed-keys table
  // and, on success, authorize as the single-tenant owner — identical to a Bearer
  // token — so downstream routes need not care which scheme was used.
  const apiKey = headers['x-api-key'];
  if (apiKey) {
    const keyId = await getApiKeyService().verify(apiKey);
    if (keyId) {
      return { isAuthorized: true, context: { sub: OWNER_SUBJECT, scheme: 'apiKey' } };
    }
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
