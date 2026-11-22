/**
 * Event processors: work triggered by an AWS event rather than an API request — the S3
 * `ObjectCreated` that delivers each received message, and the notifications that follow. A
 * processor orchestrates services, facades, and DAOs like a service does, but it serves no API
 * surface.
 */
export { ForwardingProcessor, type ForwardReceivedEmailRequest, type ForwardReceivedEmailResponse } from './forwarding-processor.js';
export { InboundProcessor, type ProcessInboundEmailRequest, type ProcessInboundEmailResponse } from './inbound-processor.js';
export { OwnLinkAttachments, type ResolveLinkedAttachmentsRequest, type ResolveLinkedAttachmentsResponse } from './own-link-attachments.js';
