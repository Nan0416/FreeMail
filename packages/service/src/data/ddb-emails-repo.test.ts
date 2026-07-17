import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbEmailsRepo, type EmailsDocClient } from './ddb-emails-repo.js';
import type { InboundEmailRecord, SentEmailRecord } from './emails-repo.js';

class FakeDoc implements EmailsDocClient {
  readonly commands: PutCommand[] = [];
  /** When set, `send` rejects with a named error (e.g. the conditional-check failure). */
  failWith?: string;
  send(command: PutCommand): Promise<unknown> {
    this.commands.push(command);
    if (this.failWith) {
      const err = new Error('conditional check failed');
      err.name = this.failWith;
      return Promise.reject(err);
    }
    return Promise.resolve({});
  }
}

function inboundRecord(overrides: Partial<InboundEmailRecord> = {}): InboundEmailRecord {
  return {
    id: 'ses-in-1',
    sesMessageId: 'ses-in-1',
    from: 'sender@example.com',
    to: ['me@mydomain.com'],
    cc: [],
    subject: 'Inbound hi',
    snippet: 'a preview',
    receivedAt: '2026-07-17T10:00:00.000Z',
    headerDate: '2026-07-17T09:59:00.000Z',
    hasAttachments: true,
    attachmentCount: 1,
    attachments: [
      {
        id: '0',
        filename: 'r.pdf',
        contentType: 'application/pdf',
        sizeBytes: 9,
        s3Key: 'attachments/inbound/ses-in-1/0',
      },
    ],
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: 'inbound/ses-in-1',
    sizeBytes: 2048,
    ...overrides,
  };
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

  it('writes a received message under the INBOUND partition, keyed by trusted receivedAt', async () => {
    const doc = new FakeDoc();
    const repo = new DdbEmailsRepo('emails-test', doc);

    const written = await repo.putInbound(inboundRecord());

    expect(written).toBe(true);
    const input = doc.commands[0]?.input;
    expect(input?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(input?.Item).toMatchObject({
      pk: 'INBOUND',
      sk: '2026-07-17T10:00:00.000Z#ses-in-1',
      direction: 'inbound',
      id: 'ses-in-1',
      from: 'sender@example.com',
      subject: 'Inbound hi',
      snippet: 'a preview',
      receivedAt: '2026-07-17T10:00:00.000Z',
      headerDate: '2026-07-17T09:59:00.000Z',
      hasAttachments: true,
      attachmentCount: 1,
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
      parseStatus: 'ok',
      quarantined: false,
      rawS3Key: 'inbound/ses-in-1',
      sizeBytes: 2048,
    });
  });

  it('returns false when the row already exists (at-least-once redelivery is a no-op)', async () => {
    const doc = new FakeDoc();
    doc.failWith = 'ConditionalCheckFailedException';
    const repo = new DdbEmailsRepo('emails-test', doc);

    expect(await repo.putInbound(inboundRecord())).toBe(false);
  });

  it('propagates a non-conditional error (infra failure → retry)', async () => {
    const doc = new FakeDoc();
    doc.failWith = 'ProvisionedThroughputExceededException';
    const repo = new DdbEmailsRepo('emails-test', doc);

    await expect(repo.putInbound(inboundRecord())).rejects.toThrow();
  });
});
