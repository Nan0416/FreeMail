import { MAX_READ_BODY_BYTES } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type { MailBodyContent, MailBodyStore } from '../../src/facades/s3-mail-body-store.js';
import {
  MAX_INLINE_BODY_BYTES,
  bodyKey,
  loadEmailBody,
  storeEmailBody,
} from '../../src/services/email-body-storage.js';

class FakeBodyStore implements MailBodyStore {
  readonly bodies = new Map<string, MailBodyContent>();
  putBody(key: string, body: MailBodyContent): Promise<void> {
    this.bodies.set(key, body);
    return Promise.resolve();
  }
  getBody(key: string): Promise<MailBodyContent | null> {
    return Promise.resolve(this.bodies.get(key) ?? null);
  }
}

describe('storeEmailBody', () => {
  it('stores nothing when there is no body at all', async () => {
    const store = new FakeBodyStore();
    expect(await storeEmailBody(store, 'k', undefined, undefined)).toBeUndefined();
    expect(store.bodies.size).toBe(0);
  });

  it('keeps a body inline at exactly the inline limit (text + html, in UTF-8 bytes)', async () => {
    const store = new FakeBodyStore();
    const html = 'h'.repeat(1000);
    const text = 't'.repeat(MAX_INLINE_BODY_BYTES - html.length);

    const stored = await storeEmailBody(store, 'k', text, html);

    expect(stored).toEqual({ kind: 'inline', text, html });
    expect(store.bodies.size).toBe(0);
  });

  it('moves a body one byte over the limit to S3 and returns its pointer', async () => {
    const store = new FakeBodyStore();
    const text = 't'.repeat(MAX_INLINE_BODY_BYTES + 1);

    const stored = await storeEmailBody(store, bodyKey('inbound', 'm1'), text, undefined);

    expect(stored).toEqual({ kind: 's3', s3Key: 'bodies/inbound/m1.json' });
    expect(store.bodies.get('bodies/inbound/m1.json')).toEqual({ text });
  });

  it('measures UTF-8 bytes, not characters', async () => {
    const store = new FakeBodyStore();
    // 3 bytes per character: under the limit in characters, over it in bytes.
    const text = '€'.repeat(Math.floor(MAX_INLINE_BODY_BYTES / 3) + 1);

    expect((await storeEmailBody(store, 'k', text, undefined))?.kind).toBe('s3');
  });

  it('caps each part to what the reader shows and flags the cut', async () => {
    const store = new FakeBodyStore();
    const text = 'x'.repeat(MAX_READ_BODY_BYTES + 10);

    await storeEmailBody(store, 'k', text, undefined);

    const saved = store.bodies.get('k')!;
    expect(saved.text!.length).toBe(MAX_READ_BODY_BYTES);
    expect(saved.truncated).toBe(true);
  });
});

describe('loadEmailBody', () => {
  it('returns an inline body as-is', async () => {
    const body = await loadEmailBody(new FakeBodyStore(), {
      kind: 'inline',
      html: '<p>x</p>',
      truncated: true,
    });
    expect(body).toEqual({ html: '<p>x</p>', truncated: true });
  });

  it('reads an S3 body from the store, or null when it is gone', async () => {
    const store = new FakeBodyStore();
    store.bodies.set('bodies/sent/s1.json', { text: 'hi' });

    expect(await loadEmailBody(store, { kind: 's3', s3Key: 'bodies/sent/s1.json' })).toEqual({
      text: 'hi',
    });
    expect(
      await loadEmailBody(store, { kind: 's3', s3Key: 'bodies/sent/missing.json' }),
    ).toBeNull();
  });
});
