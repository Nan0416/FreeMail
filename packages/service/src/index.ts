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
export { ApiKeyService, type ApiKeyServiceDeps } from './keys/service.js';
export {
  generateApiKey,
  parseApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './keys/api-key.js';
export type { ApiKeyRecord, ApiKeysRepo } from './data/keys-repo.js';
export { EmailService, type EmailServiceDeps } from './email/service.js';
export { EmailError, emailErrors } from './email/errors.js';
export { buildRawMime, type RawMimeInput } from './email/mime.js';
export { SesV2Sender, type SesSender, type SendRawParams } from './email/ses-sender.js';
export type { EmailsRepo, SentEmailRecord } from './data/emails-repo.js';
