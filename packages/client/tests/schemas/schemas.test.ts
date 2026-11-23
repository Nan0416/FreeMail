import { describe, expect, it } from 'vitest';
import { EMAIL_RECEIVED_NOTIFICATION_SCHEMA } from '../../src/schemas/notifications.js';
import {
  CREATE_ATTACHMENT_UPLOAD_RESPONSE_SCHEMA,
  DELIVERY_EVENT_SCHEMA,
  SEND_EMAIL_RESPONSE_SCHEMA,
  SERVICE_EMAIL_ATTACHMENT_SCHEMA,
  SERVICE_EMAIL_DETAIL_SCHEMA,
} from '../../src/schemas/service.js';
import type { CreateAttachmentUploadResponse, DeliveryEvent, SendEmailResponse, ServiceEmailAttachment } from '../../src/types/service.js';
import { COMPLETE_EMAIL_RECEIVED_NOTIFICATION, COMPLETE_SERVICE_EMAIL_DETAIL, type Complete } from '../fakes.js';

const COMPLETE_SEND_EMAIL_RESPONSE: Complete<SendEmailResponse> = { id: 'sent-1', messageId: 'ses-1', sentAt: '2026-11-13T17:00:00.000Z', threaded: true, replayed: false };
const COMPLETE_UPLOAD: Complete<CreateAttachmentUploadResponse> = { uploadId: 'up-1', uploadUrl: 'https://s3.example/u', uploadMethod: 'PUT', expiresAt: '2026-11-13T17:15:00.000Z' };
const COMPLETE_DELIVERY_EVENT: Complete<DeliveryEvent> = { type: 'bounced', at: '2026-11-13T17:00:07.000Z', recipients: ['sam@example.com'], detail: 'Permanent/General (5.1.1)' };
const COMPLETE_ATTACHMENT: Complete<ServiceEmailAttachment> = {
  id: '0',
  filename: 'a.pdf',
  contentType: 'application/pdf',
  sizeBytes: 3,
  downloadUrl: 'https://s3.example/a',
  downloadUrlExpiresAt: '2026-11-13T17:05:00.000Z',
};

// A schema that forgets a field still passes it through (they are loose), so compare the field names with a value
// whose type requires every field: a forgotten field would be accepted unvalidated.
describe('every response schema names every field of its type, and accepts a value with all of them', () => {
  it.each([
    ['SendEmailResponse', SEND_EMAIL_RESPONSE_SCHEMA, COMPLETE_SEND_EMAIL_RESPONSE],
    ['CreateAttachmentUploadResponse', CREATE_ATTACHMENT_UPLOAD_RESPONSE_SCHEMA, COMPLETE_UPLOAD],
    ['DeliveryEvent', DELIVERY_EVENT_SCHEMA, COMPLETE_DELIVERY_EVENT],
    ['ServiceEmailAttachment', SERVICE_EMAIL_ATTACHMENT_SCHEMA, COMPLETE_ATTACHMENT],
    ['ServiceEmailDetail', SERVICE_EMAIL_DETAIL_SCHEMA, COMPLETE_SERVICE_EMAIL_DETAIL],
    ['EmailReceivedNotification', EMAIL_RECEIVED_NOTIFICATION_SCHEMA, COMPLETE_EMAIL_RECEIVED_NOTIFICATION],
  ] as const)('%s', (_name, schema, complete) => {
    expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(complete).sort());
    expect(schema.parse(complete)).toEqual(complete);
  });
});
