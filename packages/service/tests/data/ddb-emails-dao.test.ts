import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_LIST_INDEX_ATTRIBUTES } from '@freemail/shared/storage';
import { DdbEmailsDao } from '../../src/data/ddb-emails-dao.js';
import type { CreateInboundEmailInput, CreateSentEmailInput } from '../../src/data/emails-dao.js';

/**
 * The DAOs take a real `DynamoDBDocumentClient`, so these hand-written fakes are cast at the
 * injection point. The cast is deliberate and local: the fakes implement only the handful of
 * `send` overloads the DAO under test actually issues, which is what lets these tests assert
 * the exact command — `ConditionExpression` included — with no AWS SDK involved.
 */
function asDocClient(fake: { send: (command: never) => Promise<unknown> }): DynamoDBDocumentClient {
  return fake as unknown as DynamoDBDocumentClient;
}

class FakeDoc {
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

function inboundRecord(overrides: Partial<CreateInboundEmailInput> = {}): CreateInboundEmailInput {
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
function record(overrides: Partial<CreateSentEmailInput> = {}): CreateSentEmailInput {
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
    attachments: [
      {
        id: '0',
        filename: 'a.txt',
        contentType: 'text/plain',
        sizeBytes: 3,
        s3Key: 'attachments/sent/id-1/0',
      },
    ],
    ...overrides,
  };
}

describe('DdbEmailsDao', () => {
  it('writes the sending row under the SENT partition with archive key, keyed newest-first', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.createSentEmail(record());

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
      attachments: [
        {
          id: '0',
          filename: 'a.txt',
          contentType: 'text/plain',
          sizeBytes: 3,
          s3Key: 'attachments/sent/id-1/0',
        },
      ],
    });
    // No SES id yet at the sending write — it's set on the 'sent' transition.
    expect(input?.Item?.sesMessageId).toBeUndefined();
  });

  it('updateSentStatus → sent: SETs status + sesMessageId, guarded on the row existing', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateSentEmailStatus({
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
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateSentEmailStatus({
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
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.createInboundEmail(inboundRecord());

    expect(result.created).toBe(true);
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
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.createInboundEmail(inboundRecord())).toEqual({ created: false });
  });

  it('propagates a non-conditional error (infra failure → retry)', async () => {
    const doc = new FakeDoc();
    doc.failWith = 'ProvisionedThroughputExceededException';
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await expect(dao.createInboundEmail(inboundRecord())).rejects.toThrow();
  });
});

/** A doc client that captures the command and returns a canned result, for the read paths. */
class ReadFakeDoc {
  lastCommand?: PutCommand | QueryCommand | GetCommand;
  result: unknown = {};
  send(command: PutCommand | QueryCommand | GetCommand): Promise<unknown> {
    this.lastCommand = command;
    return Promise.resolve(this.result);
  }
}

/**
 * Answers successive Queries from a queue of pages — models DynamoDB's 1 MB page cut. A query
 * on an index returns only the keys + projected attributes, as the real index does; a queued
 * Error is thrown instead of answering.
 */
class PagedFakeDoc {
  readonly queries: QueryCommand[] = [];
  describes = 0;
  /**
   * What DescribeTable reports for the list index: `undefined` = the table has no such index;
   * an Error = DescribeTable itself fails. Defaults to a ready (ACTIVE) index.
   */
  indexState: { IndexStatus: string; Backfilling?: boolean } | undefined | Error = {
    IndexStatus: 'ACTIVE',
  };
  constructor(
    private readonly pages: (
      { Items: Record<string, unknown>[]; LastEvaluatedKey?: unknown } | Error
    )[],
  ) {}
  send(command: QueryCommand | DescribeTableCommand): Promise<unknown> {
    if (command instanceof DescribeTableCommand) {
      this.describes += 1;
      if (this.indexState instanceof Error) {
        return Promise.reject(this.indexState);
      }
      const indexes = this.indexState ? [{ IndexName: 'list', ...this.indexState }] : [];
      return Promise.resolve({ Table: { GlobalSecondaryIndexes: indexes } });
    }
    this.queries.push(command);
    const page = this.pages.shift() ?? { Items: [] };
    if (page instanceof Error) {
      return Promise.reject(page);
    }
    if (command.input.IndexName === undefined) {
      return Promise.resolve(page);
    }
    const projected = new Set<string>(['pk', 'sk', ...EMAIL_LIST_INDEX_ATTRIBUTES]);
    const items = page.Items.map((item) =>
      Object.fromEntries(Object.entries(item).filter(([name]) => projected.has(name))),
    );
    return Promise.resolve({ ...page, Items: items });
  }
}

function validationError(message: string): Error {
  const err = new Error(message);
  err.name = 'ValidationException';
  return err;
}

function inboundItem(sk: string): Record<string, unknown> {
  return { ...inboundRecord(), pk: 'INBOUND', sk, direction: 'inbound' };
}

describe('DdbEmailsDao — reads', () => {
  it('queries a partition newest-first with a limit and no start key', async () => {
    const doc = new ReadFakeDoc();
    doc.result = {
      Items: [{ ...inboundRecord(), pk: 'INBOUND', sk: 'sk-1', direction: 'inbound' }],
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const page = await dao.queryEmailsByDirection({ direction: 'inbound', limit: 10 });

    const input = (doc.lastCommand as QueryCommand).input;
    expect(input.KeyConditionExpression).toBe('pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'INBOUND' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(10);
    expect(input.ExclusiveStartKey).toBeUndefined();
    expect(page.emails[0]).toMatchObject({ direction: 'inbound', sk: 'sk-1' });
  });

  it('resumes strictly after a sort key via a server-derived ExclusiveStartKey', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Items: [] };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.queryEmailsByDirection({
      direction: 'sent',
      limit: 5,
      afterSk: '2026-07-17T00:00:00.000Z#s1',
    });

    const input = (doc.lastCommand as QueryCommand).input;
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'SENT' });
    // pk comes from the direction, never the caller — sk is the only carried value.
    expect(input.ExclusiveStartKey).toEqual({ pk: 'SENT', sk: '2026-07-17T00:00:00.000Z#s1' });
  });

  it('maps a returned item to a typed row by its direction attribute', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Items: [{ ...record(), pk: 'SENT', sk: 'sk-9', direction: 'sent' }] };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const page = await dao.queryEmailsByDirection({ direction: 'sent', limit: 1 });
    expect(page.emails[0].direction).toBe('sent');
    expect(page.emails[0].sk).toBe('sk-9');
  });

  it('getByKey fetches by the full primary key and returns null when absent', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Item: { ...inboundRecord(), pk: 'INBOUND', sk: 'sk-7', direction: 'inbound' } };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const row = await dao.getEmail({ pk: 'INBOUND', sk: 'sk-7' });
    const input = (doc.lastCommand as GetCommand).input;
    expect(input.Key).toEqual({ pk: 'INBOUND', sk: 'sk-7' });
    expect(row).toMatchObject({ direction: 'inbound', sk: 'sk-7' });

    doc.result = {};
    expect(await dao.getEmail({ pk: 'INBOUND', sk: 'missing' })).toBeNull();
  });
});

describe('DdbEmailsDao — list index + paging', () => {
  it('reads the list from the list index, newest-first', async () => {
    const doc = new PagedFakeDoc([{ Items: [inboundItem('sk-1')] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 10 });

    const input = doc.queries[0].input;
    expect(input.IndexName).toBe('list');
    expect(input.KeyConditionExpression).toBe('pk = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'INBOUND' });
    expect(input.ScanIndexForward).toBe(false);
    expect(result.emails[0]).toMatchObject({ direction: 'inbound', sk: 'sk-1' });
  });

  it('keeps the full-row query on the table, not the index', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.queryEmailsByDirection({ direction: 'sent', limit: 5 });

    expect(doc.queries[0].input.IndexName).toBeUndefined();
  });

  it('follows LastEvaluatedKey after a 1 MB page cut until the page is full', async () => {
    const doc = new PagedFakeDoc([
      {
        Items: [inboundItem('sk-3'), inboundItem('sk-2')],
        LastEvaluatedKey: { pk: 'INBOUND', sk: 'sk-2' },
      },
      { Items: [inboundItem('sk-1')], LastEvaluatedKey: { pk: 'INBOUND', sk: 'sk-1' } },
    ]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 3 });

    expect(result.emails.map((e) => e.sk)).toEqual(['sk-3', 'sk-2', 'sk-1']);
    expect(doc.queries).toHaveLength(2);
    // Each follow-up asks only for what is still missing, resuming where the last page stopped.
    expect(doc.queries[0].input.Limit).toBe(3);
    expect(doc.queries[1].input.Limit).toBe(1);
    expect(doc.queries[1].input.ExclusiveStartKey).toEqual({ pk: 'INBOUND', sk: 'sk-2' });
  });

  it('returns a short page only when the partition really ends', async () => {
    const doc = new PagedFakeDoc([
      { Items: [inboundItem('sk-2')], LastEvaluatedKey: { pk: 'INBOUND', sk: 'sk-2' } },
      { Items: [inboundItem('sk-1')] },
    ]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 10 });

    expect(result.emails).toHaveLength(2);
    expect(doc.queries).toHaveLength(2);
  });

  it('resumes from a cursor sk on the first page', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5, afterSk: 'sk-9' });

    expect(doc.queries[0].input.ExclusiveStartKey).toEqual({ pk: 'SENT', sk: 'sk-9' });
  });

  it('returns only the projected list fields from the index', async () => {
    const doc = new PagedFakeDoc([{ Items: [inboundItem('sk-1')] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const summary = (await dao.listEmailSummaries({ direction: 'inbound', limit: 1 })).emails[0];

    expect(summary).toMatchObject({ direction: 'inbound', sk: 'sk-1', subject: 'Inbound hi' });
    // Not projected: bodies, descriptors, and S3 pointers never ride along in a list page.
    expect(summary).not.toHaveProperty('attachments');
    expect(summary).not.toHaveProperty('rawS3Key');
  });

  it('takes the direction from the queried partition, not a projected attribute', async () => {
    const noDirection = inboundItem('sk-1');
    delete noDirection.direction;
    const doc = new PagedFakeDoc([{ Items: [noDirection] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 1 });

    expect(result.emails[0]?.direction).toBe('inbound');
  });

  it('lists from the table while the new index is still backfilling — never a partial page', async () => {
    // A backfilling GSI answers queries with whatever it has indexed so far, so it must not be read.
    const doc = new PagedFakeDoc([{ Items: [inboundItem('sk-1')] }]);
    doc.indexState = { IndexStatus: 'CREATING', Backfilling: true };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 5 });

    expect(doc.queries.map((q) => q.input.IndexName)).toEqual([undefined]);
    expect(result.emails.map((e) => e.sk)).toEqual(['sk-1']);
  });

  it('lists from the table when the table has no list index yet', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    doc.indexState = undefined;
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5 });

    expect(doc.queries[0]?.input.IndexName).toBeUndefined();
  });

  it('lists from the table when DescribeTable itself fails', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    doc.indexState = new Error('AccessDenied');
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5 });

    expect(doc.queries[0]?.input.IndexName).toBeUndefined();
  });

  it('asks once, then trusts an ACTIVE index for the life of the DAO', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }, { Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5 });
    await dao.listEmailSummaries({ direction: 'inbound', limit: 5 });

    expect(doc.describes).toBe(1);
    expect(doc.queries.map((q) => q.input.IndexName)).toEqual(['list', 'list']);
  });

  it('re-asks at most every 30 s while the index is building, then switches over', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
      const doc = new PagedFakeDoc([{ Items: [] }, { Items: [] }, { Items: [] }]);
      doc.indexState = { IndexStatus: 'CREATING', Backfilling: true };
      const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

      await dao.listEmailSummaries({ direction: 'sent', limit: 5 });
      vi.setSystemTime(new Date('2026-10-10T00:00:10.000Z'));
      doc.indexState = { IndexStatus: 'ACTIVE' };
      await dao.listEmailSummaries({ direction: 'sent', limit: 5 }); // inside 30 s: no re-ask
      vi.setSystemTime(new Date('2026-10-10T00:00:31.000Z'));
      await dao.listEmailSummaries({ direction: 'sent', limit: 5 }); // re-asks → ACTIVE

      expect(doc.describes).toBe(2);
      expect(doc.queries.map((q) => q.input.IndexName)).toEqual([undefined, undefined, 'list']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the table if the index disappears after being trusted', async () => {
    const doc = new PagedFakeDoc([
      validationError('The table does not have the specified index: list'),
      { Items: [inboundItem('sk-1')] },
    ]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 5 });

    expect(doc.queries.map((q) => q.input.IndexName)).toEqual(['list', undefined]);
    expect(result.emails.map((e) => e.sk)).toEqual(['sk-1']);
  });

  it('does not mask any other failure behind the fallback', async () => {
    const doc = new PagedFakeDoc([validationError('ExclusiveStartKey is invalid')]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await expect(dao.listEmailSummaries({ direction: 'sent', limit: 5 })).rejects.toThrow(
      /ExclusiveStartKey/,
    );
    expect(doc.queries).toHaveLength(1);
  });
});
