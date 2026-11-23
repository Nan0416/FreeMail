import { FreeMailNotificationValidationError } from '../errors/common.js';
import { EMAIL_RECEIVED_NOTIFICATION_SCHEMA } from '../schemas/notifications.js';
import type { EmailReceivedNotification } from '../types/notifications.js';
import { validateValue } from './schema-validator.js';

/**
 * Reads an email-received notification from a message body: an SQS message from a raw-delivery subscription (the
 * notification's JSON itself), an SQS message from a subscription without raw delivery (an SNS envelope around it),
 * or a Lambda SNS record's `Sns.Message`. Throws `FreeMailNotificationValidationError` for anything else.
 */
export function parseEmailReceivedNotification(body: string): EmailReceivedNotification {
  const value = unwrapSnsEnvelope(parseJson(body, 'the body is not JSON'));
  const result = validateValue(EMAIL_RECEIVED_NOTIFICATION_SCHEMA, value, 'notification');
  if (!result.ok) {
    throw new FreeMailNotificationValidationError(result.errors);
  }
  return result.value;
}

function parseJson(text: string, failure: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new FreeMailNotificationValidationError(failure);
  }
}

/** SNS wraps the message in `{ "Type": "Notification", "Message": "<the notification's JSON>", ... }` unless delivery is raw. */
function unwrapSnsEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const envelope = value as { readonly Type?: unknown; readonly Message?: unknown };
  if (envelope.Type !== 'Notification' || typeof envelope.Message !== 'string') {
    return value;
  }
  return parseJson(envelope.Message, 'the SNS message is not JSON');
}
