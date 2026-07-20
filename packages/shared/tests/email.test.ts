import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_TOTAL_BYTES, MAX_RECIPIENTS, isValidEmailAddress } from '../src/email.js';

describe('isValidEmailAddress', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmailAddress('a@example.com')).toBe(true);
    expect(isValidEmailAddress('a.b+tag@mail.example.co.uk')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['', 'no-at', 'a@b', 'a@ b.com', 'a b@c.com', '@example.com', 'a@example']) {
      expect(isValidEmailAddress(bad)).toBe(false);
    }
  });
});

describe('email caps', () => {
  it('keeps the attachment cap conservatively under API Gateway 10 MB (after ~1.37x base64)', () => {
    expect(MAX_ATTACHMENT_TOTAL_BYTES).toBe(7 * 1024 * 1024);
    expect(Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES * 1.37)).toBeLessThan(10 * 1024 * 1024);
  });

  it('caps recipients at the SES per-message limit', () => {
    expect(MAX_RECIPIENTS).toBe(50);
  });
});
