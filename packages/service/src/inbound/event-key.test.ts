import { describe, expect, it } from 'vitest';
import { decodeEventKeyOnce, validateInboundEventKey } from './event-key.js';

describe('decodeEventKeyOnce', () => {
  it('decodes form-style encoding: + is a space, %XX is percent-decoded, exactly once', () => {
    // A doubly-encoded "%252F" must stay "%2F" (not become "/") — decoded ONCE only.
    expect(decodeEventKeyOnce('inbound/a+b')).toBe('inbound/a b');
    expect(decodeEventKeyOnce('inbound/msg%2Did')).toBe('inbound/msg-id');
    expect(decodeEventKeyOnce('inbound/x%252Fy')).toBe('inbound/x%2Fy');
  });

  it('returns null for a malformed percent-escape rather than throwing', () => {
    expect(decodeEventKeyOnce('inbound/%zz')).toBeNull();
  });
});

describe('validateInboundEventKey', () => {
  it('accepts a well-formed inbound key and extracts the message id', () => {
    const result = validateInboundEventKey('inbound/abc123_DEF.msg-1');
    expect(result).toEqual({
      ok: true,
      messageId: 'abc123_DEF.msg-1',
      rawS3Key: 'inbound/abc123_DEF.msg-1',
    });
  });

  it('rejects a key not under the inbound/ prefix', () => {
    expect(validateInboundEventKey('attachments/inbound/x/0').ok).toBe(false);
    expect(validateInboundEventKey('other/msg').ok).toBe(false);
  });

  it('rejects nested paths / traversal — the id must be a single segment', () => {
    expect(validateInboundEventKey('inbound/a/b').ok).toBe(false);
    expect(validateInboundEventKey('inbound/..%2Fetc').ok).toBe(false); // decodes to ../etc → has '/'
    expect(validateInboundEventKey('inbound/').ok).toBe(false); // empty id
  });

  it('rejects a message id with characters outside the safe charset', () => {
    // A space (from a "+"), a slash, and other punctuation are all rejected.
    expect(validateInboundEventKey('inbound/a+b').ok).toBe(false);
    expect(validateInboundEventKey('inbound/a b').ok).toBe(false);
    expect(validateInboundEventKey('inbound/a$b').ok).toBe(false);
  });

  it('rejects an undecodable key as a handled failure (no throw)', () => {
    const result = validateInboundEventKey('inbound/%zz');
    expect(result.ok).toBe(false);
  });
});
