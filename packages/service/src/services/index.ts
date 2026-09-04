/**
 * Business logic. A service owns the rules for one surface — what a valid send looks like,
 * when a login is locked out, which inbound message is quarantined — and reaches storage
 * and AWS only through injected DAOs and facades, never directly.
 */
export { AuthService, OWNER_SUBJECT, type AuthServiceDeps } from './auth-service.js';
export { ApiKeyService, type ApiKeyServiceDeps } from './api-key-service.js';
export { EmailService, type EmailServiceDeps, sentRawKey } from './email-service.js';
export {
  EmailReadService,
  type EmailReadServiceDeps,
  type GetEmailServiceRequest,
  type GetEmailServiceResponse,
  type GetAttachmentUrlServiceRequest,
  type ListEmailsServiceRequest,
} from './email-read-service.js';
export { DownloadService, type DownloadServiceDeps } from './download-service.js';
export {
  InboundProcessor,
  type ProcessInboundServiceRequest,
  type ProcessInboundServiceResponse,
} from './inbound-service.js';
