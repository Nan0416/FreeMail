/**
 * Adapters over the systems FreeMail does not own — SES, S3, and the persisted signing key.
 *
 * A facade contains no business rules. It exists so a service can depend on a small,
 * fakeable interface instead of an AWS SDK client, which is what keeps the service tests
 * free of AWS entirely.
 */
export { SesV2Sender, type SesSender, type SendRawParams } from './ses-email-facade.js';
export {
  S3AttachmentPresigner,
  type AttachmentPresigner,
  type PresignRequest,
} from './s3-attachment-presigner.js';
export { S3InboundObjectStore, type InboundObjectStore } from './s3-inbound-object-store.js';
export { S3OutboundObjectStore, type OutboundObjectStore } from './s3-outbound-object-store.js';
export {
  DdbSigningKeyProvider,
  StaticSigningKeyProvider,
  type SigningKeyProvider,
} from './signing-key-provider.js';
