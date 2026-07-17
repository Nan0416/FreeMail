import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX } from '@freemail/shared';
import { generateApiKey, hashApiKeySecret, parseApiKey, verifyApiKeySecret } from './api-key.js';

describe('generateApiKey', () => {
  it('mints an fm_-prefixed key whose parts round-trip and whose hash matches', () => {
    const generated = generateApiKey();

    expect(generated.key.startsWith(API_KEY_PREFIX)).toBe(true);
    const parsed = parseApiKey(generated.key);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId).toBe(generated.keyId);
    expect(/^[0-9a-f]+$/.test(generated.keyId)).toBe(true);
    // The stored hash is of the secret half, and it verifies against it.
    expect(verifyApiKeySecret(parsed!.secret, generated.secretHash)).toBe(true);
    // The raw secret is never the stored hash.
    expect(generated.key).not.toContain(generated.secretHash);
  });

  it('mints distinct keyIds and secrets each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.key).not.toBe(b.key);
    expect(a.secretHash).not.toBe(b.secretHash);
  });
});

describe('parseApiKey', () => {
  it('splits on the first underscore after the prefix even when the secret contains underscores', () => {
    // base64url uses "_", so the secret can contain it; the hex keyId cannot.
    const parsed = parseApiKey('fm_deadbeef_aa_bb_cc');
    expect(parsed).toEqual({ keyId: 'deadbeef', secret: 'aa_bb_cc' });
  });

  it.each([
    ['missing prefix', 'deadbeef_secret'],
    ['wrong prefix', 'gh_deadbeef_secret'],
    ['no separator', 'fm_deadbeefsecret'],
    ['empty keyId', 'fm__secret'],
    ['empty secret', 'fm_deadbeef_'],
    ['non-hex keyId', 'fm_XYZ_secret'],
    ['just the prefix', 'fm_'],
    ['empty string', ''],
  ])('rejects a malformed key (%s)', (_label, raw) => {
    expect(parseApiKey(raw)).toBeNull();
  });
});

describe('verifyApiKeySecret', () => {
  it('accepts the matching secret and rejects a different one', () => {
    const hash = hashApiKeySecret('correct-secret');
    expect(verifyApiKeySecret('correct-secret', hash)).toBe(true);
    expect(verifyApiKeySecret('wrong-secret', hash)).toBe(false);
  });

  it('returns false for a malformed stored hash instead of throwing', () => {
    expect(verifyApiKeySecret('whatever', 'not-hex-and-wrong-length')).toBe(false);
    expect(verifyApiKeySecret('whatever', '')).toBe(false);
  });
});
