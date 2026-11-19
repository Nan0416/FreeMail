import { NOTIFICATION_MAX_RECIPIENTS, NOTIFICATION_MAX_SUBJECT_CHARS } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type { CreateInboundEmailInput } from '../../src/data/emails-dao.js';
import { buildEmailReceivedNotification } from '../../src/processors/email-received-notification.js';
import { decodeEmailRef } from '../../src/utils/email-ref.js';

function record(overrides: Partial<CreateInboundEmailInput> = {}): CreateInboundEmailInput {
  return {
    id: 'MSG1',
    sesMessageId: 'MSG1',
    from: 'supplier@example.com',
    fromName: 'Acme',
    to: ['orders@warehouse.example'],
    cc: [],
    subject: 'PO 1234',
    snippet: 'never published',
    receivedAt: '2026-11-12T22:05:11.000Z',
    hasAttachments: true,
    attachmentCount: 2,
    attachments: [],
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: 'inbound/MSG1',
    sizeBytes: 184233,
    ...overrides,
  } as CreateInboundEmailInput;
}

describe('buildEmailReceivedNotification', () => {
  it('carries the metadata, versioned and typed, and an id that resolves to the row', () => {
    const n = buildEmailReceivedNotification(record());
    expect(n).toEqual({
      version: 1,
      type: 'email.received',
      id: expect.any(String),
      receivedAt: '2026-11-12T22:05:11.000Z',
      from: 'supplier@example.com',
      fromName: 'Acme',
      to: ['orders@warehouse.example'],
      cc: [],
      subject: 'PO 1234',
      hasAttachments: true,
      attachmentCount: 2,
      sizeBytes: 184233,
      spam: false,
      spamVerdict: 'PASS',
    });
    expect(decodeEmailRef(n.id)).toEqual({ pk: 'INBOUND', sk: '2026-11-12T22:05:11.000Z#MSG1' });
  });

  it('never carries body content (no snippet, text, html, or attachment keys)', () => {
    const json = JSON.stringify(buildEmailReceivedNotification(record()));
    expect(json).not.toContain('never published');
    expect(json).not.toMatch(/snippet|"text"|"html"|s3Key|rawS3Key/);
  });

  it('flags spam from the row', () => {
    const n = buildEmailReceivedNotification(record({ quarantined: true, spamVerdict: 'FAIL' }));
    expect(n.spam).toBe(true);
    expect(n.spamVerdict).toBe('FAIL');
  });

  it('caps the recipient lists and the subject, and says the lists were cut', () => {
    const many = Array.from({ length: NOTIFICATION_MAX_RECIPIENTS + 5 }, (_, i) => `r${i}@x.com`);
    const n = buildEmailReceivedNotification(
      record({
        to: many,
        cc: ['c@x.com'],
        subject: 's'.repeat(NOTIFICATION_MAX_SUBJECT_CHARS + 9),
      }),
    );
    expect(n.to).toHaveLength(NOTIFICATION_MAX_RECIPIENTS);
    expect(n.cc).toEqual(['c@x.com']);
    expect(n.recipientsTruncated).toBe(true);
    expect(n.subject).toHaveLength(NOTIFICATION_MAX_SUBJECT_CHARS);
  });

  it('omits recipientsTruncated and fromName when they do not apply', () => {
    const n = buildEmailReceivedNotification(record({ fromName: undefined }));
    expect(n).not.toHaveProperty('recipientsTruncated');
    expect(n).not.toHaveProperty('fromName');
  });

  it('gives the same id for a redelivery of the same message', () => {
    expect(buildEmailReceivedNotification(record()).id).toBe(buildEmailReceivedNotification(record()).id);
  });
});
