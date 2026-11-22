import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import type { EmailReceivedNotification } from '@freemail/shared';

/** Publishes {@link EmailReceivedNotification}s (SNS in production). */
export interface EmailReceivedNotifier {
  emailReceived(notification: EmailReceivedNotification): Promise<void>;
}

/**
 * Publishes to the email-received topic. `type` and `spam` are also message attributes, so a
 * subscriber can filter (for example `{"spam": ["false"]}`) without parsing the body.
 */
export class SnsEmailReceivedNotifier implements EmailReceivedNotifier {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {}

  async emailReceived(notification: EmailReceivedNotification): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify(notification),
        MessageAttributes: {
          type: { DataType: 'String', StringValue: notification.type },
          spam: { DataType: 'String', StringValue: String(notification.spam) },
        },
      }),
    );
  }
}
