/**
 * Response schemas. Each `satisfies` the type it validates, so a schema can't accept what the type rules out; the
 * tests check that each one names every field of its type. They are loose objects: a field a newer FreeMail adds
 * passes through.
 */
import { z } from 'zod';
import type { CreateAttachmentUploadResponse, DeliveryEvent, InboundParseStatus, InboundVerdict, SendEmailResponse, SentStatus, ServiceEmailAttachment, ServiceEmailDetail } from '../types/service.js';

export const INBOUND_VERDICTS = ['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'CONFLICTING', 'ABSENT', 'UNKNOWN'] as const satisfies readonly InboundVerdict[];
export const INBOUND_PARSE_STATUSES = ['ok', 'oversize', 'limit_exceeded', 'parse_failed'] as const satisfies readonly InboundParseStatus[];
export const SENT_STATUSES = ['sending', 'sent', 'delivered', 'bounced', 'send_failed'] as const satisfies readonly SentStatus[];
export const DELIVERY_EVENT_TYPES = ['delivered', 'bounced', 'complained', 'delayed', 'rejected'] as const satisfies readonly DeliveryEvent['type'][];

const stringArray = z.array(z.string());

export const SEND_EMAIL_RESPONSE_SCHEMA = z.looseObject({
  id: z.string(),
  messageId: z.string(),
  sentAt: z.string(),
  threaded: z.boolean().optional(),
  replayed: z.boolean().optional(),
}) satisfies z.ZodType<SendEmailResponse>;

export const CREATE_ATTACHMENT_UPLOAD_RESPONSE_SCHEMA = z.looseObject({
  uploadId: z.string(),
  uploadUrl: z.string(),
  uploadMethod: z.literal('PUT'),
  expiresAt: z.string(),
}) satisfies z.ZodType<CreateAttachmentUploadResponse>;

export const DELIVERY_EVENT_SCHEMA = z.looseObject({
  type: z.enum(DELIVERY_EVENT_TYPES),
  at: z.string(),
  recipients: stringArray,
  detail: z.string().optional(),
}) satisfies z.ZodType<DeliveryEvent>;

export const SERVICE_EMAIL_ATTACHMENT_SCHEMA = z.looseObject({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  downloadUrl: z.string(),
  downloadUrlExpiresAt: z.string(),
}) satisfies z.ZodType<ServiceEmailAttachment>;

export const SERVICE_EMAIL_DETAIL_SCHEMA = z.looseObject({
  id: z.string(),
  direction: z.enum(['sent', 'inbound']),
  from: z.string(),
  fromName: z.string().optional(),
  to: stringArray,
  cc: stringArray,
  bcc: stringArray.optional(),
  replyTo: stringArray.optional(),
  subject: z.string(),
  date: z.string(),
  status: z.enum(SENT_STATUSES).optional(),
  deliveryEvents: z.array(DELIVERY_EVENT_SCHEMA).optional(),
  headerDate: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  bodyTruncated: z.boolean().optional(),
  attachments: z.array(SERVICE_EMAIL_ATTACHMENT_SCHEMA),
  hasAttachments: z.boolean(),
  attachmentCount: z.number().int(),
  quarantined: z.boolean().optional(),
  spamVerdict: z.enum(INBOUND_VERDICTS).optional(),
  virusVerdict: z.enum(INBOUND_VERDICTS).optional(),
  parseStatus: z.enum(INBOUND_PARSE_STATUSES).optional(),
  failed: z.boolean().optional(),
  sizeBytes: z.number().int(),
}) satisfies z.ZodType<ServiceEmailDetail>;
