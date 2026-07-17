import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbEmailsRepo, type EmailsDocClient } from './ddb-emails-repo.js';
import type { SentEmailRecord } from './emails-repo.js';

class FakeDoc implements EmailsDocClient {
  readonly commands: PutCommand[] = [];
  send(command: PutCommand): Promise<unknown> {
    this.commands.push(command);
    return Promise.resolve({});
  }
}

function record(overrides: Partial<SentEmailRecord> = {}): SentEmailRecord {
  return {
    id: 'id-1',
    from: 'sender@example.com',
    to: ['a@to.com'],
    cc: ['c@cc.com'],
    bcc: ['b@bcc.com'],
    subject: 'Hello',
    sesMessageId: 'ses-msg-1',
    sentAt: '2026-07-17T00:00:00.000Z',
    attachmentCount: 2,
    sizeBytes: 4096,
    ...overrides,
  };
}

describe('DdbEmailsRepo', () => {
  it('writes a sent message under the SENT partition, keyed newest-first', async () => {
    const doc = new FakeDoc();
    const repo = new DdbEmailsRepo('emails-test', doc);

    await repo.putSent(record());

    expect(doc.commands).toHaveLength(1);
    const input = doc.commands[0]?.input;
    expect(input?.TableName).toBe('emails-test');
    expect(input?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(input?.Item).toMatchObject({
      pk: 'SENT',
      sk: '2026-07-17T00:00:00.000Z#id-1',
      direction: 'sent',
      id: 'id-1',
      from: 'sender@example.com',
      to: ['a@to.com'],
      cc: ['c@cc.com'],
      bcc: ['b@bcc.com'],
      subject: 'Hello',
      sesMessageId: 'ses-msg-1',
      attachmentCount: 2,
      sizeBytes: 4096,
    });
  });
});
