import { describe, expect, it } from 'vitest';
import type {
  EmailsDao,
  UpdateSentEmailDeliveryInput,
  UpdateSentEmailDeliveryOutput,
} from '../../src/data/emails-dao.js';
import { SesEventProcessor } from '../../src/processors/ses-event-processor.js';

const SENT_MS = Date.parse('2026-10-10T12:00:00.123Z');

/** Records the delivery updates; `found` says whether the row exists. */
function fakeDao(found = true): {
  dao: EmailsDao;
  updates: UpdateSentEmailDeliveryInput[];
} {
  const updates: UpdateSentEmailDeliveryInput[] = [];
  const dao = {
    updateSentEmailDelivery(
      input: UpdateSentEmailDeliveryInput,
    ): Promise<UpdateSentEmailDeliveryOutput> {
      updates.push(input);
      return Promise.resolve({ found });
    },
  } as unknown as EmailsDao;
  return { dao, updates };
}

function event(
  body: Record<string, unknown>,
  tags: Record<string, string[]> | null = {
    'freemail-id': ['row-1'],
    'freemail-sent': [String(SENT_MS)],
    'ses:configuration-set': ['cfg'],
  },
): string {
  return JSON.stringify({
    mail: { timestamp: '2026-10-10T12:00:01.000Z', messageId: 'ses-1', ...(tags ? { tags } : {}) },
    ...body,
  });
}

describe('SesEventProcessor', () => {
  it('records a delivery and marks the message delivered', async () => {
    const fake = fakeDao();

    const result = await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({
        eventType: 'Delivery',
        delivery: {
          timestamp: '2026-10-10T12:00:03.000Z',
          recipients: ['a@x.com'],
          smtpResponse: '250 ok',
        },
      }),
    });

    expect(result).toEqual({ outcome: 'recorded', emailId: 'row-1' });
    expect(fake.updates).toEqual([
      {
        id: 'row-1',
        sentAt: '2026-10-10T12:00:00.123Z',
        events: [{ type: 'delivered', at: '2026-10-10T12:00:03.000Z', recipients: ['a@x.com'] }],
        status: 'delivered',
      },
    ]);
  });

  it('records a bounce with its reason and marks the message bounced', async () => {
    const fake = fakeDao();

    await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({
        eventType: 'Bounce',
        bounce: {
          timestamp: '2026-10-10T12:00:04.000Z',
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            { emailAddress: 'nobody@x.com', diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
          ],
        },
      }),
    });

    expect(fake.updates[0]).toMatchObject({
      status: 'bounced',
      events: [
        {
          type: 'bounced',
          recipients: ['nobody@x.com'],
          detail: 'Permanent/General: smtp; 550 5.1.1 user unknown',
        },
      ],
    });
  });

  it.each([
    [
      'Complaint',
      {
        complaint: {
          complainedRecipients: [{ emailAddress: 'c@x.com' }],
          complaintFeedbackType: 'abuse',
        },
      },
      { type: 'complained', recipients: ['c@x.com'], detail: 'abuse' },
    ],
    [
      'DeliveryDelay',
      {
        deliveryDelay: {
          delayType: 'MailboxFull',
          delayedRecipients: [{ emailAddress: 'd@x.com', diagnosticCode: '452 full' }],
        },
      },
      { type: 'delayed', recipients: ['d@x.com'], detail: 'MailboxFull: 452 full' },
    ],
  ])('records a %s without changing the status', async (eventType, body, expected) => {
    const fake = fakeDao();

    await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({ eventType, ...body }),
    });

    expect(fake.updates[0]?.status).toBeUndefined();
    expect(fake.updates[0]?.events[0]).toMatchObject(expected);
  });

  it('records a reject as a failed send', async () => {
    const fake = fakeDao();

    await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({ eventType: 'Reject', reject: { reason: 'Bad content' } }),
    });

    expect(fake.updates[0]).toMatchObject({
      status: 'send_failed',
      events: [{ type: 'rejected', recipients: [], detail: 'Bad content' }],
    });
  });

  it('reads the older notification shape (notificationType) too', async () => {
    const fake = fakeDao();

    await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({ notificationType: 'Delivery', delivery: { recipients: ['a@x.com'] } }),
    });

    expect(fake.updates[0]?.status).toBe('delivered');
  });

  it('strips control characters and line breaks from what a remote server wrote', async () => {
    const fake = fakeDao();

    await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({
        eventType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [
            { emailAddress: 'a@x.com', diagnosticCode: 'line one\r\nline\u0000two' },
          ],
        },
      }),
    });

    expect(fake.updates[0]?.events[0]?.detail).toBe('Permanent: line one line two');
  });

  it.each([
    ['not JSON', 'not json', 'not JSON'],
    ['a report without FreeMail tags', event({ eventType: 'Delivery' }, null), 'no FreeMail tags'],
    [
      'a report with a malformed send time',
      event({ eventType: 'Delivery' }, { 'freemail-id': ['row-1'], 'freemail-sent': ['soon'] }),
      'no FreeMail tags',
    ],
    ['an event it does not track', event({ eventType: 'Open' }), 'untracked event Open'],
  ])('skips %s without writing', async (_label, message, reason) => {
    const fake = fakeDao();

    const result = await new SesEventProcessor(fake.dao).processSesEvent({ message });

    expect(result).toMatchObject({ outcome: 'skipped', reason });
    expect(fake.updates).toEqual([]);
  });

  it('skips a report about a message whose row is not there', async () => {
    const fake = fakeDao(false);

    const result = await new SesEventProcessor(fake.dao).processSesEvent({
      message: event({ eventType: 'Delivery', delivery: { recipients: ['a@x.com'] } }),
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'no such message', emailId: 'row-1' });
  });
});
