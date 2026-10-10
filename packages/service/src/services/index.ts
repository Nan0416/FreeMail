/**
 * Business logic. A service owns the rules for one surface — what a valid send looks like,
 * when a login is locked out, which inbound message is quarantined — and reaches storage
 * and AWS only through injected DAOs and facades, never directly.
 */
export { AuthService, OWNER_SUBJECT, type AuthServiceDeps } from './auth-service.js';
export { ApiKeyService, type ApiKeyServiceDeps } from './api-key-service.js';
export {
  EmailService,
  type EmailServiceDeps,
  type SendEmailServiceRequest,
  sentRawKey,
} from './email-service.js';
export {
  EmailReadService,
  type EmailReadServiceDeps,
  type GetEmailServiceRequest,
  type GetEmailServiceResponse,
  type GetAttachmentUrlServiceRequest,
  type ListEmailsServiceRequest,
} from './email-read-service.js';
export {
  AttachmentService,
  type AttachmentServiceDeps,
  type CreateAttachmentUploadServiceRequest,
  type ResolveAttachmentDownloadPresignedUrlServiceRequest,
  type ResolveAttachmentDownloadPresignedUrlServiceResponse,
} from './attachment-service.js';
