import { describe, expect, it } from 'vitest';
import { FreeMailNotificationValidationError } from '../../src/errors/common.js';
import { parseEmailReceivedNotification } from '../../src/utils/notifications.js';
import { buildEmailReceivedNotification, COMPLETE_EMAIL_RECEIVED_NOTIFICATION } from '../fakes.js';

describe('parseEmailReceivedNotification', () => {
  it('reads a notification delivered raw', () => {
    expect(parseEmailReceivedNotification(JSON.stringify(COMPLETE_EMAIL_RECEIVED_NOTIFICATION))).toEqual(COMPLETE_EMAIL_RECEIVED_NOTIFICATION);
  });

  it('reads a notification inside an SNS envelope (a subscription without raw delivery)', () => {
    const envelope = { Type: 'Notification', MessageId: 'm-1', TopicArn: 'arn:aws:sns:us-east-1:111111111111:freemail-email-received', Message: JSON.stringify(buildEmailReceivedNotification()) };

    expect(parseEmailReceivedNotification(JSON.stringify(envelope))).toEqual(buildEmailReceivedNotification());
  });

  it('keeps a field FreeMail adds later', () => {
    const notification = { ...buildEmailReceivedNotification(), addedLater: 'kept' };

    expect(parseEmailReceivedNotification(JSON.stringify(notification))).toEqual(notification);
  });

  it('throws for a body that is not JSON', () => {
    expect(() => parseEmailReceivedNotification('not json')).toThrow(FreeMailNotificationValidationError);
  });

  it('throws for an SNS envelope whose message is not JSON', () => {
    expect(() => parseEmailReceivedNotification(JSON.stringify({ Type: 'Notification', Message: 'hello' }))).toThrow('the SNS message is not JSON');
  });

  it.each([
    ['another version', { version: 2 }],
    ['another type', { type: 'email.sent' }],
    ['recipients that are not a list', { to: 'alex@corp.example' }],
    ['a verdict FreeMail does not declare', { spamVerdict: 'MAYBE' }],
    ['a fractional attachment count', { attachmentCount: 1.5 }],
  ])('throws for %s', (_label, overrides) => {
    const body = JSON.stringify({ ...buildEmailReceivedNotification(), ...overrides });

    expect(() => parseEmailReceivedNotification(body)).toThrow(FreeMailNotificationValidationError);
  });

  it('names the missing field', () => {
    const notification: Record<string, unknown> = { ...buildEmailReceivedNotification() };
    delete notification.id;

    expect(() => parseEmailReceivedNotification(JSON.stringify(notification))).toThrow('notification.id: ');
  });
});
