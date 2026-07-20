/**
 * Lambda REQUEST authorizer for the HTTP API (SIMPLE response format).
 *
 * Dual-scheme by design (`DESIGN.md § Auth`: "a Lambda authorizer covers both
 * REST access-tokens and MCP API-keys"). As of #31 the human/web access token
 * arrives ONLY as the `__Host-fm_access` httpOnly cookie (Bearer was dropped — no
 * non-browser human caller depends on it), while an `x-api-key` header authorizes
 * the MCP server's agent keys, validated against the hashed-keys table. Because
 * either credential may be present, the CDK authorizer runs with no fixed identity
 * source and caching off, so this function always sees the full request — a stale
 * cache entry keyed on a now-authoritative cookie would be a session-confusion bug.
 */
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { getSigningKey } from '../config/signing-key.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { OWNER_SUBJECT } from '../auth/service.js';
import { ACCESS_COOKIE, DUPLICATE_COOKIE, readCookie } from '../auth/cookies.js';
import { DdbApiKeysRepo } from '../data/ddb-keys-repo.js';
import { ApiKeyService } from '../keys/service.js';

interface AuthorizerContext {
  readonly sub: string;
  readonly scheme: 'access' | 'apiKey';
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

  // Human/web credential: the access JWT in the __Host-fm_access cookie. A duplicate
  // (injected) same-name cookie is rejected outright rather than guessed.
  const access = readCookie(event.cookies, ACCESS_COOKIE);
  if (access === DUPLICATE_COOKIE) {
    return DENY;
  }
  if (typeof access === 'string') {
    const result = await verifyAccessToken(
      access,
      await getSigningKey(),
      Math.floor(Date.now() / 1000),
    );
    if (result.valid) {
      return { isAuthorized: true, context: { sub: result.claims.sub, scheme: 'access' } };
    }
    return DENY;
  }

  // No access cookie → the only other credential is an agent's `x-api-key` (MCP).
  // Validate it against the hashed-keys table and, on success, authorize as the
  // single-tenant owner, so downstream routes need not care which scheme was used.
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
