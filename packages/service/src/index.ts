/**
 * FreeMail backend — Lambda handlers for the REST API and (later) the MCP server.
 *
 * The Lambda entry points live in `handlers/` and are bundled directly by CDK.
 * This barrel re-exports the framework-free auth core so it can be reused and
 * unit-tested without pulling in the AWS SDK.
 */
import { healthOk, type HealthReport } from '@freemail/shared';

export function serviceHealth(): HealthReport {
  return healthOk('@freemail/service');
}

export { AuthService, OWNER_SUBJECT, type AuthServiceDeps } from './auth/service.js';
export { AuthError, authErrors } from './auth/errors.js';
export { hashPassword, verifyPassword } from './auth/password.js';
export {
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type VerifyResult,
} from './auth/jwt.js';
export { generateRefreshToken, hashRefreshToken } from './auth/refresh-token.js';
export * from './auth/lockout.js';
export type { AuthRepo } from './data/auth-repo.js';
