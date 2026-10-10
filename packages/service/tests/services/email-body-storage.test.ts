import { MAX_READ_BODY_BYTES } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type { CreateInboundEmailInput, StoredEmailBody } from '../../src/data/emails-dao.js';
import {
  parseStoredBody,
  type MailBodyContent,
  type MailBodyStore,
} from '../../src/facades/s3-mail-body-store.js';
import {
  MAX_INLINE_BODY_BYTES,
  MAX_INLINE_ROW_BYTES,
  bodyKey,
  estimateRowBytes,
  loadEmailBody,
  storeEmailBody,
} from '../../src/services/email-body-storage.js';

/** Round-trips every body through JSON, like the real S3 object, so nothing rides by reference. */
class FakeBodyStore implements MailBodyStore {
  readonly objects = new Map<string, string>();
  putBody(key: string, body: MailBodyContent): Promise<void> {
    this.objects.set(key, JSON.stringify(body));
    return Promise.resolve();
  }
  getBody(key: string): Promise<MailBodyContent | null> {
    const raw = this.objects.get(key);
    return Promise.resolve(raw === undefined ? null : parseStoredBody(raw));
  }
}

/** DynamoDB's own item-size rule: attribute names + string values in UTF-8, numbers, nesting. */
function dynamoItemBytes(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  if (typeof value === 'number') {
    return 21; // upper bound for a number
  }
  if (typeof value === 'boolean' || value === null) {
    return 1;
  }
  if (Array.isArray(value)) {
    return 3 + value.reduce((sum: number, item) => sum + 1 + dynamoItemBytes(item), 0);
  }
  if (typeof value === 'object') {
    return (
      3 +
      Object.entries(value as Record<string, unknown>).reduce(
        (sum, [name, item]) =>
          item === undefined
            ? sum
            : sum + 1 + Buffer.byteLength(name, 'utf8') + dynamoItemBytes(item),
        0,
      )
    );
  }
  return 0;
}

/** The largest envelope an inbound row can carry: every capped field at its cap, 4-byte chars. */
function worstCaseInboundRow(): CreateInboundEmailInput {
  const wide = (chars: number): string => '\u{1F4E7}'.repeat(chars / 2); // 2 UTF-16 units each
  const address = (i: number): string => `${wide(310)}${i}@x.co`;
  return {
    id: 'm'.repeat(64),
    sesMessageId: 'm'.repeat(64),
    from: address(0),
    fromName: wide(320),
    to: Array.from({ length: 50 }, (_, i) => address(i)),
    cc: Array.from({ length: 50 }, (_, i) => address(i + 50)),
    subject: wide(998),
    snippet: wide(300),
    receivedAt: '2026-10-10T00:00:00.000Z',
    headerDate: '2026-10-10T00:00:00.000Z',
    hasAttachments: true,
    attachmentCount: 25,
    attachments: Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      filename: wide(254),
      contentType: wide(128),
      sizeBytes: 15 * 1024 * 1024,
      s3Key: `attachments/inbound/${'m'.repeat(64)}/${i}`,
    })),
    spamVerdict: 'PASS',
    virusVerdict: 'PASS',
    parseStatus: 'ok',
    quarantined: false,
    rawS3Key: `inbound/${'m'.repeat(64)}`,
    sizeBytes: 40 * 1024 * 1024,
  };
}

describe('storeEmailBody', () => {
  it('stores an EMPTY inline body when there is no text or html (attachments only)', async () => {
    const store = new FakeBodyStore();
    expect(await storeEmailBody(store, { key: 'k', otherRowBytes: 0 })).toEqual({
      kind: 'inline',
    });
    expect(store.objects.size).toBe(0);
  });

  it('keeps a body inline at exactly the inline limit (text + html, in UTF-8 bytes)', async () => {
    const store = new FakeBodyStore();
    const html = 'h'.repeat(1000);
    const text = 't'.repeat(MAX_INLINE_BODY_BYTES - html.length);

    const stored = await storeEmailBody(store, { key: 'k', text, html, otherRowBytes: 1024 });

    expect(stored).toEqual({ kind: 'inline', text, html });
    expect(store.objects.size).toBe(0);
  });

  it('moves a body one byte over the limit to S3 and returns its pointer', async () => {
    const store = new FakeBodyStore();
    const text = 't'.repeat(MAX_INLINE_BODY_BYTES + 1);

    const stored = await storeEmailBody(store, {
      key: bodyKey('inbound', 'm1'),
      text,
      otherRowBytes: 1024,
    });

    expect(stored).toEqual({ kind: 's3', s3Key: 'bodies/inbound/m1.json' });
    expect(await store.getBody('bodies/inbound/m1.json')).toEqual({ text });
  });

  it('moves even a small body to S3 when the rest of the row leaves no room for it', async () => {
    const store = new FakeBodyStore();
    const text = 't'.repeat(10 * 1024);

    const stored = await storeEmailBody(store, {
      key: 'k',
      text,
      otherRowBytes: MAX_INLINE_ROW_BYTES - 5 * 1024,
    });

    expect(stored.kind).toBe('s3');
  });

  it('measures UTF-8 bytes, not characters', async () => {
    const store = new FakeBodyStore();
    // 3 bytes per character: under the limit in characters, over it in bytes.
    const text = '€'.repeat(Math.floor(MAX_INLINE_BODY_BYTES / 3) + 1);

    expect((await storeEmailBody(store, { key: 'k', text, otherRowBytes: 0 })).kind).toBe('s3');
  });

  it('caps each part to what the reader shows and flags the cut', async () => {
    const store = new FakeBodyStore();
    const text = 'x'.repeat(MAX_READ_BODY_BYTES + 10);

    await storeEmailBody(store, { key: 'k', text, otherRowBytes: 0 });

    const saved = (await store.getBody('k'))!;
    expect(saved.text!.length).toBe(MAX_READ_BODY_BYTES);
    expect(saved.truncated).toBe(true);
  });

  it('keeps the worst-case inbound row under DynamoDB’s 400 KB item limit', async () => {
    const store = new FakeBodyStore();
    const row = worstCaseInboundRow();
    const body = await storeEmailBody(store, {
      key: 'k',
      text: 'b'.repeat(MAX_INLINE_BODY_BYTES),
      otherRowBytes: estimateRowBytes(row),
    });
    const item = {
      pk: 'INBOUND',
      sk: `${row.receivedAt}#${row.id}`,
      direction: 'inbound',
      ...row,
      body,
    };

    expect(dynamoItemBytes(item)).toBeLessThan(MAX_INLINE_ROW_BYTES);
  });

  it('never under-counts a row (the estimate bounds DynamoDB’s own size)', () => {
    const row = worstCaseInboundRow();
    expect(estimateRowBytes(row)).toBeGreaterThanOrEqual(dynamoItemBytes(row));
  });
});

describe('loadEmailBody', () => {
  it('returns an inline body', async () => {
    const body = await loadEmailBody(new FakeBodyStore(), {
      kind: 'inline',
      html: '<p>x</p>',
      truncated: true,
    });
    expect(body).toEqual({ html: '<p>x</p>', truncated: true });
  });

  it('drops badly typed inline fields and rejects a pointer it did not write', async () => {
    const store = new FakeBodyStore();
    const odd = { kind: 'inline', text: 42, html: '<p>ok</p>' } as unknown as StoredEmailBody;
    expect(await loadEmailBody(store, odd)).toEqual({ html: '<p>ok</p>' });
    expect(await loadEmailBody(store, { kind: 'weird' } as unknown as StoredEmailBody)).toBeNull();
  });

  it('reads an S3 body from the store, or null when it is gone', async () => {
    const store = new FakeBodyStore();
    await store.putBody('bodies/sent/s1.json', { text: 'hi' });

    expect(await loadEmailBody(store, { kind: 's3', s3Key: 'bodies/sent/s1.json' })).toEqual({
      text: 'hi',
    });
    expect(
      await loadEmailBody(store, { kind: 's3', s3Key: 'bodies/sent/missing.json' }),
    ).toBeNull();
  });
});
