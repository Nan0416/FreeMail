/**
 * The data layer's public surface: the key schema, the shared document client, and every
 * DAO paired with its DynamoDB implementation.
 *
 * Each DAO is an INTERFACE plus a `Ddb*` implementation, so a service depends on the seam
 * rather than on DynamoDB and its whole flow is unit-testable against an in-memory fake.
 */
export { createDocumentClient } from './document-client.js';
export {
  ApiKeyEntity,
  AuthEntity,
  CONDITIONAL_CHECK_FAILED,
  DownloadTokenEntity,
  EmailEntity,
  isConditionalCheckFailed,
  type TableKey,
} from './entities.js';
export { optimisticUpdate, type VersionedValue } from './optimistic.js';

export type {
  AuthDao,
  ClearLockoutInput,
  ClearLockoutOutput,
  ConsumeRefreshTokenInput,
  ConsumeRefreshTokenOutput,
  CreatePasswordHashInput,
  CreatePasswordHashOutput,
  CreateSigningKeyInput,
  CreateSigningKeyOutput,
  GetLockoutInput,
  GetLockoutOutput,
  GetPasswordHashInput,
  GetPasswordHashOutput,
  GetSigningKeyInput,
  GetSigningKeyOutput,
  PutRefreshTokenInput,
  PutRefreshTokenOutput,
  RegisterFailedAttemptInput,
  RegisterFailedAttemptOutput,
} from './auth-dao.js';
export { DdbAuthDao } from './ddb-auth-dao.js';

export type {
  ApiKeysDao,
  CreateApiKeyInput,
  CreateApiKeyOutput,
  DeleteApiKeyInput,
  DeleteApiKeyOutput,
  GetApiKeyInput,
  GetApiKeyOutput,
  ListApiKeysInput,
  ListApiKeysOutput,
} from './api-keys-dao.js';
export { DdbApiKeysDao } from './ddb-api-keys-dao.js';

export type {
  CreateInboundEmailInput,
  CreateInboundEmailOutput,
  CreateSentEmailInput,
  CreateSentEmailOutput,
  EmailsDao,
  GetEmailInput,
  GetEmailOutput,
  QueryEmailsByDirectionInput,
  QueryEmailsByDirectionOutput,
  UpdateSentEmailStatusInput,
  UpdateSentEmailStatusOutput,
} from './emails-dao.js';
export { INBOUND_PARTITION, SENT_PARTITION } from './emails-dao.js';
export { DdbEmailsDao } from './ddb-emails-dao.js';

export type {
  ClaimDownloadTokenInput,
  CreateDownloadTokenInput,
  CreateDownloadTokenOutput,
  DownloadTokensDao,
  ClaimDownloadTokenOutput,
} from './download-tokens-dao.js';
export { DdbDownloadTokensDao } from './ddb-download-tokens-dao.js';
