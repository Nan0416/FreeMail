import type { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { EmailReceivedNotification } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import { SnsEmailReceivedNotifier } from '../../src/facades/sns-email-received-notifier.js';

const NOTIFICATION: EmailReceivedNotification = {
  version: 1,
  type: 'email.received',
  id: 'handle-1',
  receivedAt: '2026-11-12T22:05:11.000Z',
  from: 'supplier@example.com',
  to: ['orders@warehouse.example'],
  cc: [],
  subject: 'PO 1234',
  hasAttachments: false,
  attachmentCount: 0,
  sizeBytes: 1200,
  spam: true,
  spamVerdict: 'FAIL',
};

describe('SnsEmailReceivedNotifier', () => {
  it('publishes the JSON body to the topic, with type and spam as filterable attributes', async () => {
    const commands: PublishCommand[] = [];
    const client = {
      send(command: PublishCommand) {
        commands.push(command);
        return Promise.resolve({ MessageId: 'sns-1' });
      },
    } as unknown as SNSClient;

    await new SnsEmailReceivedNotifier(client, 'arn:aws:sns:us-east-1:1:topic').emailReceived(NOTIFICATION);

    expect(commands).toHaveLength(1);
    const input = commands[0]!.input;
    expect(input.TopicArn).toBe('arn:aws:sns:us-east-1:1:topic');
    expect(JSON.parse(input.Message!)).toEqual(NOTIFICATION);
    expect(input.MessageAttributes).toEqual({
      type: { DataType: 'String', StringValue: 'email.received' },
      spam: { DataType: 'String', StringValue: 'true' },
    });
  });

  it('lets a publish failure propagate, so the Lambda retries', async () => {
    const client = {
      send: () => Promise.reject(new Error('throttled')),
    } as unknown as SNSClient;
    await expect(new SnsEmailReceivedNotifier(client, 'arn').emailReceived(NOTIFICATION)).rejects.toThrow('throttled');
  });
});
