/**
 * `@freemail/client`: a TypeScript client for a FreeMail deployment's API, authorized with an API key.
 */
export { FreeMailClientImpl, type FreeMailClientProps } from './clients/freemail-client-impl.js';
export {
  FreeMailApiError,
  FreeMailAuthError,
  FreeMailEmailNotFoundError,
  FreeMailNotificationValidationError,
  FreeMailResponseValidationError,
  FreeMailUploadError,
  type FreeMailApiErrorClasses,
} from './errors/common.js';
export type { FetchLike, FetchLikeInit, FetchLikeResponse } from './types/http.js';
export { EMAIL_RECEIVED_TYPE, EMAIL_RECEIVED_VERSION, type EmailReceivedNotification } from './types/notifications.js';
export type {
  CreateAttachmentUploadRequest,
  CreateAttachmentUploadResponse,
  DeliveryEvent,
  EmailAttachmentRef,
  EmailDirection,
  FreeMailClient,
  FreeMailRequestOptions,
  GetEmailRequest,
  InboundParseStatus,
  InboundVerdict,
  SendEmailRequest,
  SendEmailResponse,
  SentStatus,
  ServiceEmailAttachment,
  ServiceEmailDetail,
  StoredAttachmentRef,
  UploadAttachmentRef,
  UploadAttachmentRequest,
} from './types/service.js';
export { parseEmailReceivedNotification } from './utils/notifications.js';
