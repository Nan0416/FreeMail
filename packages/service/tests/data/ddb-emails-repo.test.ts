import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbEmailsRepo, type EmailsDocClient } from '../../src/data/ddb-emails-repo.js';
import type { InboundEmailRecord, SentEmailRecord } from '../../src/data/emails-repo.js';

class FakeDoc implements EmailsDocClient {
  readonly commands: (PutCommand | UpdateCommand)[] = [];
  /** When set, `send` rejects with a named error (e.g. the conditional-check failure). */
  failWith?: string;
  send(command: PutCommand | UpdateCommand): Promise<unknown> {
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

/** The write-before-send initial row shape: status 'sending', archive key, no SES id yet. */
function record(overrides: Partial<SentEmailRecord> = {}): SentEmailRecord {
  return {
    id: 'id-1',
    from: 'sender@example.com',
    to: ['a@to.com'],
    cc: ['c@cc.com'],
    bcc: ['b@bcc.com'],
    subject: 'Hello',
    sentAt: '2026-07-17T00:00:00.000Z',
    attachmentCount: 2,
    sizeBytes: 4096,
    status: 'sending',
    rawS3Key: 'sent/id-1',
    ...overrides,
  };
}

describe('DdbEmailsRepo', () => {
  it('writes the sending row under the SENT partition with archive key, keyed newest-first', async () => {
    const doc = new FakeDoc();
    const repo = new DdbEmailsRepo('emails-test', doc);

    await repo.putSent(record());

    expect(doc.commands).toHaveLength(1);
    const input = (doc.commands[0] as PutCommand).input;
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
      status: 'sending',
      rawS3Key: 'sent/id-1',
      attachmentCount: 2,
      sizeBytes: 4096,
    });
    // No SES id yet at the sending write — it's set on the 'sent' transition.
    expect(input?.Item?.sesMessageId).toBeUndefined();
  });

  it('updateSentStatus → sent: SETs status + sesMessageId, guarded on the row existing', async () => {
    const doc = new FakeDoc();
    const repo = new DdbEmailsRepo('emails-test', doc);

    await repo.updateSentStatus({
      id: 'id-1',
      sentAt: '2026-07-17T00:00:00.000Z',
      status: 'sent',
      sesMessageId: 'ses-msg-1',
    });

    const input = (doc.commands[0] as UpdateCommand).input;
    expect(input?.Key).toEqual({ pk: 'SENT', sk: '2026-07-17T00:00:00.000Z#id-1' });
    expect(input?.UpdateExpression).toBe('SET #status = :status, #mid = :mid');
    expect(input?.ExpressionAttributeNames).toEqual({
      '#status': 'status',
      '#mid': 'sesMessageId',
    });
    expect(input?.ExpressionAttributeValues).toEqual({ ':status': 'sent', ':mid': 'ses-msg-1' });
    expect(input?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('updateSentStatus → send_failed: SETs status + error', async () => {
    const doc = new FakeDoc();
    const repo = new DdbEmailsRepo('emails-test', doc);

    await repo.updateSentStatus({
      id: 'id-1',
      sentAt: '2026-07-17T00:00:00.000Z',
      status: 'send_failed',
      error: 'SES rejected: throttled',
    });

    const input = (doc.commands[0] as UpdateCommand).input;
    expect(input?.UpdateExpression).toBe('SET #status = :status, #error = :error');
    expect(input?.ExpressionAttributeNames).toEqual({ '#status': 'status', '#error': 'error' });
    expect(input?.ExpressionAttributeValues).toEqual({
      ':status': 'send_failed',
      ':error': 'SES rejected: throttled',
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

/** A doc client that captures the command and returns a canned result, for the read paths. */
class ReadFakeDoc implements EmailsDocClient {
  lastCommand?: PutCommand | QueryCommand | GetCommand;
  result: unknown = {};
  send(command: PutCommand | QueryCommand | GetCommand): Promise<unknown> {
    this.lastCommand = command;
    return Promise.resolve(this.result);
  }
}

describe('DdbEmailsRepo — reads', () => {
  it('queries a partition newest-first with a limit and no start key', async () => {
    const doc = new ReadFakeDoc();
    doc.result = {
      Items: [{ ...inboundRecord(), pk: 'INBOUND', sk: 'sk-1', direction: 'inbound' }],
    };
    const repo = new DdbEmailsRepo('emails-test', doc);

    const rows = await repo.queryDirection('inbound', { limit: 10 });

    const input = (doc.lastCommand as QueryCommand).input;
    expect(input.KeyConditionExpression).toBe('pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'INBOUND' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(10);
    expect(input.ExclusiveStartKey).toBeUndefined();
    expect(rows[0]).toMatchObject({ direction: 'inbound', sk: 'sk-1' });
  });

  it('resumes strictly after a sort key via a server-derived ExclusiveStartKey', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Items: [] };
    const repo = new DdbEmailsRepo('emails-test', doc);

    await repo.queryDirection('sent', { limit: 5, afterSk: '2026-07-17T00:00:00.000Z#s1' });

    const input = (doc.lastCommand as QueryCommand).input;
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'SENT' });
    // pk comes from the direction, never the caller — sk is the only carried value.
    expect(input.ExclusiveStartKey).toEqual({ pk: 'SENT', sk: '2026-07-17T00:00:00.000Z#s1' });
  });

  it('maps a returned item to a typed row by its direction attribute', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Items: [{ ...record(), pk: 'SENT', sk: 'sk-9', direction: 'sent' }] };
    const repo = new DdbEmailsRepo('emails-test', doc);

    const rows = await repo.queryDirection('sent', { limit: 1 });
    expect(rows[0].direction).toBe('sent');
    expect(rows[0].sk).toBe('sk-9');
  });

  it('getByKey fetches by the full primary key and returns null when absent', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Item: { ...inboundRecord(), pk: 'INBOUND', sk: 'sk-7', direction: 'inbound' } };
    const repo = new DdbEmailsRepo('emails-test', doc);

    const row = await repo.getByKey({ pk: 'INBOUND', sk: 'sk-7' });
    const input = (doc.lastCommand as GetCommand).input;
    expect(input.Key).toEqual({ pk: 'INBOUND', sk: 'sk-7' });
    expect(row).toMatchObject({ direction: 'inbound', sk: 'sk-7' });

    doc.result = {};
    expect(await repo.getByKey({ pk: 'INBOUND', sk: 'missing' })).toBeNull();
  });
});
