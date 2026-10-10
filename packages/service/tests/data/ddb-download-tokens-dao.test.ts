import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DdbDownloadTokensDao } from '../../src/data/ddb-download-tokens-dao.js';
import type { ClaimDownloadTokenOutput } from '../../src/data/download-tokens-dao.js';

function conditionalCheckFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

/**
 * In-memory document client that honors the conditional put AND evaluates the claim's
 * ConditionExpression against the stored row exactly as DynamoDB would (exists, not
 * revoked, not expired via lexicographic ISO compare, under the optional cap). This
 * exercises the real gate + increment behavior — including a download cap — without AWS.
 * DynamoDB applies the same condition + `SET ... + :one` atomically, so a real concurrent
 * race cannot exceed the cap; here the sequential fake demonstrates the boundary.
 */
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
  readonly store = new Map<string, Record<string, unknown>>();
  readonly updateInputs: UpdateCommand['input'][] = [];

  send(
    command: GetCommand | PutCommand | UpdateCommand,
  ): Promise<{ Attributes?: Record<string, unknown>; Item?: Record<string, unknown> }> {
    if (command instanceof GetCommand) {
      const item = this.store.get(String(command.input.Key?.token));
      return Promise.resolve(item ? { Item: { ...item } } : {});
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item as Record<string, unknown>;
      const key = String(item.token);
      if (
        command.input.ConditionExpression?.includes('attribute_not_exists') &&
        this.store.has(key)
      ) {
        return Promise.reject(conditionalCheckFailed());
      }
      this.store.set(key, item);
      return Promise.resolve({});
    }
    // UpdateCommand: the atomic gate + increment.
    this.updateInputs.push(command.input);
    const key = String(command.input.Key?.token);
    const item = this.store.get(key);
    const values = command.input.ExpressionAttributeValues ?? {};
    const now = String(values[':now']);
    const passes =
      !!item &&
      item.revoked === false &&
      String(item.expiresAt) > now &&
      (item.maxDownloads === undefined || Number(item.downloadCount) < Number(item.maxDownloads));
    if (!passes || !item) {
      return Promise.reject(conditionalCheckFailed());
    }
    item.downloadCount = Number(item.downloadCount ?? 0) + 1;
    return Promise.resolve({ Attributes: { ...item } });
  }
}

function record(overrides: Partial<ClaimDownloadTokenOutput> = {}): ClaimDownloadTokenOutput {
  return {
    token: 'tok-1',
    s3Key: 'attachments/outbound/email-1/0',
    filename: 'report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 5 * 1024 * 1024,
    emailId: 'email-1',
    createdAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2026-08-17T00:00:00.000Z',
    ttl: Math.floor(Date.parse('2026-08-17T00:00:00.000Z') / 1000),
    revoked: false,
    downloadCount: 0,
    ...overrides,
  };
}

const NOW = '2026-07-18T12:00:00.000Z';

describe('DdbDownloadTokensDao.create', () => {
  it('writes the row conditionally so a token collision cannot clobber an existing one', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');

    await dao.createDownloadToken(record());

    const stored = doc.store.get('tok-1');
    expect(stored).toMatchObject({
      token: 'tok-1',
      s3Key: 'attachments/outbound/email-1/0',
      filename: 'report.pdf',
      revoked: false,
      downloadCount: 0,
      ttl: expect.any(Number),
    });
    // The collision guard is expressed against the key attribute.
    await expect(dao.createDownloadToken(record())).rejects.toThrow(/conditional/i);
  });

  it('omits maxDownloads when unset and includes it when set', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ token: 'a' }));
    await dao.createDownloadToken(record({ token: 'b', maxDownloads: 3 }));
    expect(doc.store.get('a')).not.toHaveProperty('maxDownloads');
    expect(doc.store.get('b')).toMatchObject({ maxDownloads: 3 });
  });
});

describe('DdbDownloadTokensDao — sender + own-domain recipients', () => {
  it('stores and reads back who sent the message and its own-domain recipients', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(
      record({ sender: 'me@example.com', ownDomainRecipients: ['team@example.com'] }),
    );

    expect(await dao.getDownloadToken({ token: 'tok-1' })).toEqual(
      record({ sender: 'me@example.com', ownDomainRecipients: ['team@example.com'] }),
    );
  });

  it('omits an empty recipient list, and a token without either field reads back without them', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ token: 'a', ownDomainRecipients: [] }));
    await dao.createDownloadToken(record({ token: 'b' }));

    expect(doc.store.get('a')).not.toHaveProperty('ownDomainRecipients');
    const legacy = await dao.getDownloadToken({ token: 'b' });
    expect(legacy).not.toHaveProperty('sender');
    expect(legacy).not.toHaveProperty('ownDomainRecipients');
  });
});

describe('DdbDownloadTokensDao.get', () => {
  it('reads a token without claiming it — no download is counted, whatever its gates', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ revoked: true }));

    expect(await dao.getDownloadToken({ token: 'tok-1' })).toMatchObject({
      revoked: true,
      downloadCount: 0,
    });
    expect(doc.updateInputs).toHaveLength(0);
    expect(doc.store.get('tok-1')?.downloadCount).toBe(0);
  });

  it('answers null for an unknown token', async () => {
    const dao = new DdbDownloadTokensDao(asDocClient(new FakeDoc()), 'tokens');
    expect(await dao.getDownloadToken({ token: 'nope' })).toBeNull();
  });
});

describe('DdbDownloadTokensDao.claim', () => {
  it('claims a valid token, incrementing the counter and returning the row', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record());

    const claimed = await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW });

    expect(claimed).not.toBeNull();
    expect(claimed?.downloadCount).toBe(1);
    expect(claimed?.s3Key).toBe('attachments/outbound/email-1/0');
    // The gate + increment ride ONE conditional UpdateItem returning the new row.
    const input = doc.updateInputs[0];
    expect(input.ReturnValues).toBe('ALL_NEW');
    expect(input.UpdateExpression).toContain('downloadCount');
    expect(input.ConditionExpression).toContain('revoked = :false');
    expect(input.ConditionExpression).toContain('expiresAt > :now');
    expect(input.ConditionExpression).toContain('downloadCount < maxDownloads');
  });

  it('fails closed (null) for an unknown token — and writes no phantom row', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    expect(await dao.claimDownloadToken({ token: 'nope', nowIso: NOW })).toBeNull();
    expect(doc.store.size).toBe(0);
  });

  it('fails closed (null) for a revoked token', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ revoked: true }));
    expect(await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW })).toBeNull();
  });

  it('fails closed (null) once the token has expired (server-authoritative)', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ expiresAt: '2026-07-18T00:00:00.000Z' })); // before NOW
    expect(await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW })).toBeNull();
  });

  it('enforces a download cap atomically — the claim past the cap fails closed', async () => {
    const doc = new FakeDoc();
    const dao = new DdbDownloadTokensDao(asDocClient(doc), 'tokens');
    await dao.createDownloadToken(record({ maxDownloads: 2 }));

    expect((await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW }))?.downloadCount).toBe(1);
    expect((await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW }))?.downloadCount).toBe(2);
    // Third claim is blocked by the condition (downloadCount < maxDownloads is now false).
    expect(await dao.claimDownloadToken({ token: 'tok-1', nowIso: NOW })).toBeNull();
  });
});
