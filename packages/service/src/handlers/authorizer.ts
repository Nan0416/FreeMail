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
import { getSigningKey } from '../utils/signing-key.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { OWNER_SUBJECT } from '../services/auth-service.js';
import { ACCESS_COOKIE, DUPLICATE_COOKIE, readCookie } from '../utils/cookies.js';
import { DdbApiKeysDao } from '../data/ddb-api-keys-dao.js';
import { DdbAuthDao } from '../data/ddb-auth-dao.js';
import { ApiKeyService } from '../services/api-key-service.js';
import { createDocumentClient } from '../data/document-client.js';
import { getAuthorizerConfig } from './authorizer-config.js';

interface AuthorizerContext {
  readonly sub: string;
  readonly scheme: 'access' | 'apiKey';
}

// Reused across warm invocations. API-key verification is a table read; no signing key needed.
interface AuthorizerDeps {
  readonly apiKeyService: ApiKeyService;
  /** Read-only view of the auth table — the authorizer holds no write grant on it. */
  readonly authDao: DdbAuthDao;
}

let deps: AuthorizerDeps | undefined;

function init(): AuthorizerDeps {
  if (deps) {
    return deps;
  }
  const config = getAuthorizerConfig();
  const doc = createDocumentClient();
  deps = {
    apiKeyService: new ApiKeyService({ apiKeysDao: new DdbApiKeysDao(doc, config.apiKeysTable) }),
    authDao: new DdbAuthDao(doc, config.authTable),
  };
  return deps;
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
    // Fail closed when no key has been generated yet: the login route mints the key
    // before it can issue a token, so a cookie presented against an empty table was
    // never signed by this deployment.
    const signingKey = await getSigningKey(init().authDao);
    if (signingKey === null) {
      return DENY;
    }
    const result = await verifyAccessToken(access, signingKey, Math.floor(Date.now() / 1000));
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
    const verified = await init().apiKeyService.verify({ rawKey: apiKey });
    if (verified) {
      return { isAuthorized: true, context: { sub: OWNER_SUBJECT, scheme: 'apiKey' } };
    }
    return DENY;
  }

  return DENY;
};
