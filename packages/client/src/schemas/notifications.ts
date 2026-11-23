import { z } from 'zod';
import { EMAIL_RECEIVED_TYPE, EMAIL_RECEIVED_VERSION, type EmailReceivedNotification } from '../types/notifications.js';
import { INBOUND_VERDICTS } from './service.js';

const stringArray = z.array(z.string());

/** A loose object: a field a newer FreeMail adds passes through. */
export const EMAIL_RECEIVED_NOTIFICATION_SCHEMA = z.looseObject({
  version: z.literal(EMAIL_RECEIVED_VERSION),
  type: z.literal(EMAIL_RECEIVED_TYPE),
  id: z.string(),
  receivedAt: z.string(),
  from: z.string(),
  fromName: z.string().optional(),
  to: stringArray,
  cc: stringArray,
  recipientsTruncated: z.literal(true).optional(),
  subject: z.string(),
  hasAttachments: z.boolean(),
  attachmentCount: z.number().int(),
  sizeBytes: z.number().int(),
  spam: z.boolean(),
  spamVerdict: z.enum(INBOUND_VERDICTS),
}) satisfies z.ZodType<EmailReceivedNotification>;
