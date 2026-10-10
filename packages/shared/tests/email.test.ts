import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBED_ATTACHMENT_BYTES,
  DEFAULT_EMBED_TOTAL_BYTES,
  MAX_RAW_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MAX_UPLOAD_BYTES,
  isValidEmailAddress,
} from '../src/email.js';

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
  it('uploads up to 100 MB per attachment (delivered as a link when that large)', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });

  it('keeps the default embedded total well inside SES’s 40 MB message (after ~1.37x base64)', () => {
    expect(DEFAULT_EMBED_ATTACHMENT_BYTES).toBeLessThanOrEqual(DEFAULT_EMBED_TOTAL_BYTES);
    expect(Math.ceil(DEFAULT_EMBED_TOTAL_BYTES * 1.37)).toBeLessThan(MAX_RAW_MESSAGE_BYTES / 2);
  });

  it('caps recipients at the SES per-message limit', () => {
    expect(MAX_RECIPIENTS).toBe(50);
  });
});
