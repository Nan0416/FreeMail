/**
 * Event processors: work triggered by an AWS event rather than an API request — today, the
 * S3 `ObjectCreated` that delivers each received message. A processor orchestrates services,
 * facades, and DAOs like a service does, but it serves no API surface.
 */
export {
  InboundProcessor,
  type ProcessInboundEmailRequest,
  type ProcessInboundEmailResponse,
} from './inbound-processor.js';
export {
  OwnLinkAttachments,
  type ResolveLinkedAttachmentsRequest,
  type ResolveLinkedAttachmentsResponse,
} from './own-link-attachments.js';
