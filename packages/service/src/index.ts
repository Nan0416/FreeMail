/**
 * FreeMail backend — the package's public surface.
 *
 * The Lambda entry points live in `handlers/` and are bundled directly by CDK, so nothing
 * here is on a runtime path. This barrel re-exports the layers that are useful outside the
 * service (and unit-testable without AWS), following the layering the source is organised
 * into: `services/` business logic, `facades/` external-system adapters, `data/` DAOs,
 * `utils/` pure helpers.
 */
import { healthOk, type HealthReport } from '@freemail/shared';

export function serviceHealth(): HealthReport {
  return healthOk('@freemail/service');
}

export * from './services/index.js';
export * from './facades/index.js';
export * from './data/index.js';
export { AuthError, EmailError, authErrors, emailErrors } from './utils/errors.js';
export { InboundParseError, InboundLimitError, isHandledInboundError } from './utils/errors.js';
export { hashPassword, verifyPassword } from './utils/password.js';
export {
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type VerifyResult,
} from './utils/jwt.js';
export { generateRefreshToken, hashRefreshToken } from './utils/refresh-token.js';
export * from './utils/lockout.js';
export {
  generateApiKey,
  parseApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './utils/api-key.js';
export { buildRawMime, type RawMimeInput } from './utils/mime.js';
