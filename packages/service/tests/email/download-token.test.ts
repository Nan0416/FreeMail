import { describe, expect, it } from 'vitest';
import {
  downloadUrl,
  generateDownloadToken,
  isValidDownloadToken,
  outboundAttachmentKey,
} from '../../src/email/download-token.js';

describe('generateDownloadToken', () => {
  it('mints a URL-safe, high-entropy token', () => {
    const token = generateDownloadToken();
    // 32 random bytes → 43 base64url chars (no padding), alphabet [A-Za-z0-9_-] only.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
    expect(token).not.toContain('=');
  });

  it('is unique across draws (no collisions in a large sample)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateDownloadToken());
    }
    expect(seen.size).toBe(1000);
  });
});

describe('isValidDownloadToken', () => {
  it('accepts a freshly minted token (exactly 43 base64url chars)', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(isValidDownloadToken(generateDownloadToken())).toBe(true);
    }
  });

  it.each([
    ['empty', ''],
    ['one char short', 'A'.repeat(42)],
    ['one char long', 'A'.repeat(44)],
    ['overlong past the DynamoDB 2 KB key limit', 'A'.repeat(5000)],
    ['contains + (not base64url)', `${'A'.repeat(42)}+`],
    ['contains / (not base64url)', `${'A'.repeat(42)}/`],
    ['contains padding =', `${'A'.repeat(42)}=`],
  ])('rejects a %s token', (_label, token) => {
    expect(isValidDownloadToken(token)).toBe(false);
  });
});

describe('outboundAttachmentKey', () => {
  it('namespaces the opaque key by email id and index', () => {
    expect(outboundAttachmentKey('email-1', 0)).toBe('attachments/outbound/email-1/0');
    expect(outboundAttachmentKey('email-1', 2)).toBe('attachments/outbound/email-1/2');
  });
});

describe('downloadUrl', () => {
  it('builds the /d/{token} link and tolerates a trailing slash on the base', () => {
    expect(downloadUrl('https://api.example.com', 'tok')).toBe('https://api.example.com/d/tok');
    expect(downloadUrl('https://api.example.com/', 'tok')).toBe('https://api.example.com/d/tok');
    expect(downloadUrl('https://api.example.com///', 'tok')).toBe('https://api.example.com/d/tok');
  });

  it('needs no encoding — base64url tokens are already path-safe', () => {
    const token = generateDownloadToken();
    expect(downloadUrl('https://api.example.com', token)).toBe(
      `https://api.example.com/d/${token}`,
    );
  });
});
