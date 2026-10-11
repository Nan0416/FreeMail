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
  /** What a successful `send` resolves with (e.g. an update's old `Attributes`). */
  response: Record<string, unknown> = {};
  send(command: PutCommand | UpdateCommand): Promise<unknown> {
    this.commands.push(command);
    if (this.failWith) {
      const err = new Error('conditional check failed');
      err.name = this.failWith;
      return Promise.reject(err);
    }
    return Promise.resolve(this.response);
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
  it('persists the stored body on both sent and inbound rows', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.createSentEmail(record({ body: { kind: 'inline', text: 'Hi', html: '<p>Hi</p>' } }));
    await dao.createInboundEmail(
      inboundRecord({ body: { kind: 's3', s3Key: 'bodies/inbound/ses-in-1.json' } }),
    );

    expect((doc.commands[0] as PutCommand).input.Item?.body).toEqual({
      kind: 'inline',
      text: 'Hi',
      html: '<p>Hi</p>',
    });
    expect((doc.commands[1] as PutCommand).input.Item?.body).toEqual({
      kind: 's3',
      s3Key: 'bodies/inbound/ses-in-1.json',
    });
  });

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
    expect(input?.ExpressionAttributeValues).toEqual({
      ':status': 'sent',
      ':mid': 'ses-msg-1',
      ':sending': 'sending',
    });
    // Only from 'sending': a delivery report that got there first is never walked back.
    expect(input?.ConditionExpression).toBe('attribute_exists(pk) AND #status = :sending');
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
      ':sending': 'sending',
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

describe('DdbEmailsDao — Errors folder', () => {
  it('files a failed inbound message under FAILED, with its quarantine pointer', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.createInboundEmail(
      inboundRecord({ failed: true, quarantineS3Key: 'inbound/ses-in-1.eml' }),
    );

    const item = (doc.commands[0] as PutCommand).input.Item!;
    expect(item.pk).toBe('FAILED');
    expect(item.sk).toBe(`${inboundRecord().receivedAt}#${inboundRecord().id}`);
    expect(item).toMatchObject({
      direction: 'inbound',
      failed: true,
      quarantineS3Key: 'inbound/ses-in-1.eml',
    });
  });

  it('keeps a normal inbound message under INBOUND', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.createInboundEmail(inboundRecord());

    expect((doc.commands[0] as PutCommand).input.Item!.pk).toBe('INBOUND');
  });

  it('lists the FAILED partition as inbound rows that carry their pk', async () => {
    const doc = new PagedFakeDoc([
      { Items: [{ ...inboundRecord(), pk: 'FAILED', sk: 'sk-1', direction: 'inbound' }] },
    ]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({ direction: 'failed', limit: 5 });

    expect(doc.queries[0]?.input.ExpressionAttributeValues).toEqual({ ':pk': 'FAILED' });
    expect(result.emails[0]).toMatchObject({ direction: 'inbound', pk: 'FAILED', sk: 'sk-1' });
  });

  it('returns a row with the partition it was read from', async () => {
    const doc = new ReadFakeDoc();
    doc.result = { Item: { ...inboundRecord(), pk: 'FAILED', sk: 'sk-7', direction: 'inbound' } };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const row = await dao.getEmail({ pk: 'FAILED', sk: 'sk-7' });

    expect(row).toMatchObject({ direction: 'inbound', pk: 'FAILED', sk: 'sk-7' });
  });
});

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

  it('falls back to the table if the index disappears, and stops trusting it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
      const doc = new PagedFakeDoc([
        validationError('The table does not have the specified index: list'),
        { Items: [inboundItem('sk-1')] },
        { Items: [] },
      ]);
      const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

      const result = await dao.listEmailSummaries({ direction: 'inbound', limit: 5 });
      expect(doc.queries.map((q) => q.input.IndexName)).toEqual(['list', undefined]);
      expect(result.emails.map((e) => e.sk)).toEqual(['sk-1']);
      // From the table, only the list fields are read — never full items with their bodies.
      const fallback = doc.queries[1]!.input;
      expect(Object.values(fallback.ExpressionAttributeNames ?? {})).toEqual(
        expect.arrayContaining(['pk', 'sk', 'from', 'to', 'subject', 'status']),
      );
      expect(Object.values(fallback.ExpressionAttributeNames ?? {})).not.toContain('body');
      expect(fallback.ProjectionExpression).toMatch(/^#l0, #l1, /);

      // The trust was reset: the next call (after the recheck window) asks DescribeTable again.
      doc.indexState = undefined;
      vi.setSystemTime(new Date('2026-10-10T00:00:31.000Z'));
      await dao.listEmailSummaries({ direction: 'inbound', limit: 5 });
      expect(doc.describes).toBe(2);
      expect(doc.queries[2]?.input.IndexName).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read an ACTIVE index that is still backfilling', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    doc.indexState = { IndexStatus: 'ACTIVE', Backfilling: true };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5 });

    expect(doc.queries[0]?.input.IndexName).toBeUndefined();
  });

  it('reads an index that is UPDATING a setting — it is already fully built', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    doc.indexState = { IndexStatus: 'UPDATING' };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5 });

    expect(doc.queries[0]?.input.IndexName).toBe('list');
  });

  it('shares one DescribeTable between concurrent first calls', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }, { Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await Promise.all([
      dao.listEmailSummaries({ direction: 'sent', limit: 5 }),
      dao.listEmailSummaries({ direction: 'inbound', limit: 5 }),
    ]);

    expect(doc.describes).toBe(1);
    expect(doc.queries.map((q) => q.input.IndexName)).toEqual(['list', 'list']);
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

describe('DdbEmailsDao — threading fields', () => {
  it('writes an inbound message id, references, and reply-to', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.createInboundEmail(
      inboundRecord({
        messageIdHeader: '<m@x>',
        references: ['<r@x>'],
        replyTo: ['desk@example.com'],
      }),
    );

    expect(doc.commands[0]?.input?.Item).toMatchObject({
      messageIdHeader: '<m@x>',
      references: ['<r@x>'],
      replyTo: ['desk@example.com'],
    });
  });
});

describe('DdbEmailsDao — sent Message-ID', () => {
  it('sets the Message-ID with the sent transition', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateSentEmailStatus({
      id: 'e1',
      sentAt: '2026-07-17T10:00:00.000Z',
      status: 'sent',
      sesMessageId: 's1',
      messageIdHeader: '<s1@email.amazonses.com>',
    });

    const input = doc.commands[0]?.input as {
      UpdateExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.UpdateExpression).toContain('#msgid = :msgid');
    expect(input.ExpressionAttributeNames?.['#msgid']).toBe('messageIdHeader');
    expect(input.ExpressionAttributeValues?.[':msgid']).toBe('<s1@email.amazonses.com>');
  });
});

describe('DdbEmailsDao.listEmailSummaries — date range', () => {
  it('bounds the sort key on both sides', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({
      direction: 'inbound',
      limit: 5,
      minSk: '2026-10-01T00:00:00.000Z',
      maxSk: '2026-10-02T00:00:00.000Z',
    });

    const input = doc.queries[0].input;
    expect(input.KeyConditionExpression).toBe('pk = :pk AND sk BETWEEN :lo AND :hi');
    expect(input.ExpressionAttributeValues).toEqual({
      ':pk': 'INBOUND',
      ':lo': '2026-10-01T00:00:00.000Z',
      ':hi': '2026-10-02T00:00:00.000Z',
    });
  });

  it('bounds one side when only one is given', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }, { Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5, minSk: 'A' });
    await dao.listEmailSummaries({ direction: 'sent', limit: 5, maxSk: 'B' });

    expect(doc.queries[0].input.KeyConditionExpression).toBe('pk = :pk AND sk >= :lo');
    expect(doc.queries[1].input.KeyConditionExpression).toBe('pk = :pk AND sk <= :hi');
  });

  it('starts from the ceiling when a cursor lies above it (filters changed between pages)', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5, afterSk: 'Z#1', maxSk: 'M' });

    expect(doc.queries[0].input.ExclusiveStartKey).toBeUndefined();
  });

  it('reads nothing when the cursor is at or below the floor', async () => {
    const doc = new PagedFakeDoc([]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({
      direction: 'sent',
      limit: 5,
      afterSk: 'A',
      minSk: 'B',
    });

    expect(result.emails).toEqual([]);
    expect(doc.queries).toHaveLength(0);
  });
});

describe('DdbEmailsDao — send idempotency records', () => {
  const claim = {
    key: 'k-1',
    claimId: 'claim-1',
    requestFingerprint: 'fp',
    createdAt: '2026-10-10T00:00:00.000Z',
    nowSeconds: 1760054400,
    ttl: 1760140800,
  };

  it('claims a key in one atomic write that keeps an existing record and returns it', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.createIdempotencyRecord(claim)).toEqual({ created: true });

    const input = doc.commands[0]?.input as {
      Key?: unknown;
      UpdateExpression?: string;
      ReturnValues?: string;
    };
    expect(input.Key).toEqual({ pk: 'SEND_KEY', sk: 'k-1' });
    expect(input.UpdateExpression).toContain('#fp = if_not_exists(#fp, :fp)');
    expect(input.UpdateExpression).toContain('#ttl = if_not_exists(#ttl, :ttl)');
    expect(input.ReturnValues).toBe('ALL_OLD');
  });

  it('reports the earlier record when the key was already claimed', async () => {
    const doc = new FakeDoc();
    doc.response = {
      Attributes: {
        pk: 'SEND_KEY',
        sk: 'k-1',
        requestFingerprint: 'fp-0',
        state: 'sent',
        claimId: 'claim-0',
        response: { id: 'h', messageId: 'm', sentAt: 't' },
        createdAt: '2026-10-09T00:00:00.000Z',
        ttl: 1760140000,
      },
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.createIdempotencyRecord(claim)).toEqual({
      created: false,
      existing: {
        key: 'k-1',
        requestFingerprint: 'fp-0',
        state: 'sent',
        response: { id: 'h', messageId: 'm', sentAt: 't' },
        createdAt: '2026-10-09T00:00:00.000Z',
        ttl: 1760140000,
      },
    });
  });

  it('records the response on completion', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateIdempotencyRecord({
      key: 'k-1',
      response: { id: 'h', messageId: 'm', sentAt: 't' },
    });

    const input = doc.commands[0]?.input as {
      Key?: unknown;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(input.Key).toEqual({ pk: 'SEND_KEY', sk: 'k-1' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':sent': 'sent',
      ':response': { id: 'h', messageId: 'm', sentAt: 't' },
    });
  });

  it('releases only a pending claim, and treats a completed one as already settled', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');
    await dao.deleteIdempotencyRecord({ key: 'k-1' });
    expect((doc.commands[0]?.input as { ConditionExpression?: string }).ConditionExpression).toBe(
      '#state = :pending',
    );

    doc.failWith = 'ConditionalCheckFailedException';
    await expect(dao.deleteIdempotencyRecord({ key: 'k-1' })).resolves.toEqual({});
  });
});

describe('DdbEmailsDao.listEmailSummaries — range edges', () => {
  it('reads nothing for an empty range', async () => {
    const doc = new PagedFakeDoc([]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    const result = await dao.listEmailSummaries({
      direction: 'sent',
      limit: 5,
      minSk: 'B',
      maxSk: 'A',
    });

    expect(result.emails).toEqual([]);
    expect(doc.queries).toHaveLength(0);
  });

  it('reads nothing for a cursor exactly at the floor, and resumes from one at the ceiling', async () => {
    const doc = new PagedFakeDoc([{ Items: [] }]);
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.listEmailSummaries({ direction: 'sent', limit: 5, afterSk: 'B', minSk: 'B' });
    expect(doc.queries).toHaveLength(0);

    await dao.listEmailSummaries({ direction: 'sent', limit: 5, afterSk: 'M', maxSk: 'M' });
    expect(doc.queries[0]?.input.ExclusiveStartKey).toEqual({ pk: 'SENT', sk: 'M' });
  });
});

describe('DdbEmailsDao — idempotency claims: retries and expiry', () => {
  const claim = {
    key: 'k-9',
    claimId: 'claim-b',
    requestFingerprint: 'fp',
    createdAt: '2026-10-10T00:00:00.000Z',
    nowSeconds: 1760054400,
    ttl: 1760140800,
  };

  it('treats its own earlier write (an SDK retry after a lost response) as the claim', async () => {
    const doc = new FakeDoc();
    doc.response = {
      Attributes: { requestFingerprint: 'fp', state: 'pending', claimId: 'claim-b', ttl: 1 },
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.createIdempotencyRecord(claim)).toEqual({ created: true });
  });

  it('takes over an expired record DynamoDB has not swept yet, compare-and-swap on its ttl', async () => {
    const doc = new FakeDoc();
    doc.response = {
      Attributes: {
        requestFingerprint: 'other',
        state: 'sent',
        claimId: 'claim-a',
        createdAt: '2026-10-01T00:00:00.000Z',
        ttl: claim.nowSeconds - 60,
      },
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.createIdempotencyRecord(claim)).toEqual({ created: true });
    const takeover = doc.commands[1]?.input as {
      ConditionExpression?: string;
      UpdateExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(takeover.ConditionExpression).toBe('#ttl = :oldTtl OR #claim = :claim');
    expect(takeover.UpdateExpression).toContain('REMOVE #response');
    expect(takeover.ExpressionAttributeValues?.[':oldTtl']).toBe(claim.nowSeconds - 60);
  });

  it('reports a live claim when someone else renewed the expired record first', async () => {
    const doc = new FakeDoc();
    doc.response = {
      Attributes: {
        requestFingerprint: 'fp',
        state: 'sent',
        claimId: 'claim-a',
        createdAt: '2026-10-01T00:00:00.000Z',
        ttl: claim.nowSeconds - 60,
      },
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');
    const send = doc.send.bind(doc);
    let calls = 0;
    doc.send = (command) => {
      calls += 1;
      if (calls === 2) {
        doc.commands.push(command);
        const err = new Error('conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      }
      return send(command);
    };

    expect(await dao.createIdempotencyRecord(claim)).toMatchObject({
      created: false,
      existing: { state: 'pending' },
    });
  });
});

describe('DdbEmailsDao — delivery reports', () => {
  const report = {
    id: 'e1',
    sentAt: '2026-10-10T12:00:00.000Z',
    events: [
      { type: 'delivered' as const, at: '2026-10-10T12:00:03.000Z', recipients: ['a@x.com'] },
    ],
  };

  it('appends the events to an existing row, then advances the status only forward', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.updateSentEmailDelivery({ ...report, status: 'bounced' })).toEqual({
      found: true,
    });

    const append = doc.commands[0]?.input as {
      Key?: unknown;
      UpdateExpression?: string;
      ConditionExpression?: string;
    };
    expect(append.Key).toEqual({ pk: 'SENT', sk: '2026-10-10T12:00:00.000Z#e1' });
    expect(append.UpdateExpression).toBe(
      'SET #events = list_append(if_not_exists(#events, :empty), :events)',
    );
    expect(append.ConditionExpression).toBe('attribute_exists(pk)');
    const status = doc.commands[1]?.input as {
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, unknown>;
    };
    expect(status.ConditionExpression).toBe('#status IN (:from0, :from1, :from2)');
    expect(status.ExpressionAttributeValues).toEqual({
      ':status': 'bounced',
      ':from0': 'sending',
      ':from1': 'sent',
      ':from2': 'delivered',
    });
  });

  it('never moves a delivered message past a bounce (delivered only from sending/sent)', async () => {
    const doc = new FakeDoc();
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateSentEmailDelivery({ ...report, status: 'delivered' });

    expect(
      (doc.commands[1]?.input as { ExpressionAttributeValues?: Record<string, unknown> })
        .ExpressionAttributeValues,
    ).toEqual({ ':status': 'delivered', ':from0': 'sending', ':from1': 'sent' });
  });

  it('reports a row that is not there, and writes nothing more', async () => {
    const doc = new FakeDoc();
    doc.failWith = 'ConditionalCheckFailedException';
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    expect(await dao.updateSentEmailDelivery({ ...report, status: 'delivered' })).toEqual({
      found: false,
    });
    expect(doc.commands).toHaveLength(1);
  });
});

describe('DdbEmailsDao.updateSentEmailStatus — never walks a status back', () => {
  it("marks sent only from 'sending', and still records the SES ids when a report got there first", async () => {
    const doc = new FakeDoc();
    let calls = 0;
    const send = doc.send.bind(doc);
    doc.send = (command) => {
      calls += 1;
      if (calls === 1) {
        doc.commands.push(command);
        const err = new Error('conditional check failed');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      }
      return send(command);
    };
    const dao = new DdbEmailsDao(asDocClient(doc), 'emails-test');

    await dao.updateSentEmailStatus({
      id: 'e1',
      sentAt: '2026-10-10T12:00:00.000Z',
      status: 'sent',
      sesMessageId: 's1',
      messageIdHeader: '<s1@email.amazonses.com>',
    });

    const first = doc.commands[0]?.input as { ConditionExpression?: string };
    expect(first.ConditionExpression).toBe('attribute_exists(pk) AND #status = :sending');
    const second = doc.commands[1]?.input as {
      UpdateExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
    };
    expect(second.UpdateExpression).toBe('SET #mid = :mid, #msgid = :msgid');
    expect(Object.values(second.ExpressionAttributeNames ?? {})).not.toContain('status');
  });
});
