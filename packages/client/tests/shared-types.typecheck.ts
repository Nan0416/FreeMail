/**
 * Compile-time only (`tsc -p tsconfig.test.json`): fails when the client's copies of the wire types drift from the ones
 * the service declares in `@freemail/shared`, including a field added or removed on either side.
 */
import type * as shared from '@freemail/shared';
import type * as client from '../src/index.js';
import type { DELIVERY_EVENT_TYPES, INBOUND_PARSE_STATUSES, INBOUND_VERDICTS, SENT_STATUSES } from '../src/schemas/service.js';

/** True when A and B have the same keys and each is assignable to the other. */
type Same<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? ([A] extends [B] ? ([B] extends [A] ? true : false) : false) : false) : false;
type Assert<T extends true> = T;

export type WireTypesMatch = [
  Assert<Same<client.UploadAttachmentRef, shared.UploadAttachmentRef>>,
  Assert<Same<client.StoredAttachmentRef, shared.StoredAttachmentRef>>,
  Assert<Same<client.CreateAttachmentUploadRequest, shared.CreateAttachmentUploadRequest>>,
  Assert<Same<client.CreateAttachmentUploadResponse, shared.CreateAttachmentUploadResponse>>,
  Assert<Same<client.SendEmailRequest, shared.SendEmailRequest>>,
  Assert<Same<client.SendEmailResponse, shared.SendEmailResponse>>,
  Assert<Same<client.DeliveryEvent, shared.DeliveryEvent>>,
  Assert<Same<client.ServiceEmailAttachment, shared.ServiceEmailAttachment>>,
  Assert<Same<client.ServiceEmailDetail, shared.ServiceEmailDetail>>,
  Assert<Same<client.EmailReceivedNotification, shared.EmailReceivedNotification>>,
  Assert<Same<client.EmailDirection, shared.EmailDirection>>,
  Assert<Same<client.SentStatus, shared.SentStatus>>,
  Assert<Same<client.InboundVerdict, shared.InboundVerdict>>,
  Assert<Same<client.InboundParseStatus, shared.InboundParseStatus>>,
  // The schemas' enum lists cover every value of their union, so a valid value is never refused.
  Assert<Same<(typeof INBOUND_VERDICTS)[number], shared.InboundVerdict>>,
  Assert<Same<(typeof INBOUND_PARSE_STATUSES)[number], shared.InboundParseStatus>>,
  Assert<Same<(typeof SENT_STATUSES)[number], shared.SentStatus>>,
  Assert<Same<(typeof DELIVERY_EVENT_TYPES)[number], shared.DeliveryEvent['type']>>,
  Assert<Same<typeof client.EMAIL_RECEIVED_TYPE, typeof shared.EMAIL_RECEIVED_TYPE>>,
  Assert<Same<typeof client.EMAIL_RECEIVED_VERSION, typeof shared.EMAIL_RECEIVED_VERSION>>,
];
