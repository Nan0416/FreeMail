import { describe, expect, it } from 'vitest';
import { isValidIdempotencyKey, requestFingerprint } from '../../src/utils/idempotency.js';

describe('isValidIdempotencyKey', () => {
  it.each(['a', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'run:42.retry_1', 'x'.repeat(128)])(
    'accepts %s',
    (key) => {
      expect(isValidIdempotencyKey(key)).toBe(true);
    },
  );

  it.each(['', 'x'.repeat(129), 'has space', 'slash/key', 'ünïcode', 42])('rejects %s', (key) => {
    expect(isValidIdempotencyKey(key)).toBe(false);
  });
});

describe('requestFingerprint', () => {
  const base = { from: 'a@x.com', to: ['b@y.com'], subject: 'Hi', text: 'hello' };

  it('ignores key order and the key itself', () => {
    expect(requestFingerprint({ ...base, idempotencyKey: 'k1' })).toBe(
      requestFingerprint({ text: 'hello', subject: 'Hi', to: ['b@y.com'], from: 'a@x.com' }),
    );
  });

  it('treats an absent field and an undefined one alike', () => {
    expect(requestFingerprint({ ...base, cc: undefined })).toBe(requestFingerprint(base));
  });

  it('changes with any content', () => {
    expect(requestFingerprint({ ...base, text: 'hello!' })).not.toBe(requestFingerprint(base));
    expect(requestFingerprint({ ...base, to: ['c@y.com'] })).not.toBe(requestFingerprint(base));
    expect(
      requestFingerprint({ ...base, attachments: [{ uploadId: 'AAAAAAAAAAAAAAAAAAAAAA' }] }),
    ).not.toBe(requestFingerprint(base));
  });
});
