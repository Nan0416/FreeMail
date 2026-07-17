import type { AddressObject } from 'mailparser';
import { describe, expect, it } from 'vitest';
import {
  normalizeAddressList,
  normalizeFrom,
  sanitizeContentType,
  sanitizeFilename,
  sanitizeSubject,
  sanitizeText,
  snippetFromHtml,
  snippetFromText,
} from './sanitize.js';

describe('sanitizeText', () => {
  it('strips control chars + CRLF and collapses whitespace', () => {
    expect(sanitizeText('a\r\nb\tc\x00d', 100)).toBe('a b c d');
  });

  it('caps length', () => {
    expect(sanitizeText('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('returns empty for undefined', () => {
    expect(sanitizeText(undefined, 10)).toBe('');
  });
});

describe('sanitizeSubject', () => {
  it('neutralizes a CRLF-injection attempt in the subject', () => {
    // An attacker subject trying to inject a fake header line collapses to one line.
    expect(sanitizeSubject('Hi\r\nBcc: victim@x.com')).toBe('Hi Bcc: victim@x.com');
  });
});

describe('sanitizeFilename', () => {
  it('neutralizes path traversal + separators (metadata only, never the S3 key)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('a\\b/c')).toBe('a_b_c');
  });

  it('strips CRLF/control chars', () => {
    expect(sanitizeFilename('re\r\nport.pdf')).toBe('re port.pdf');
  });

  it('falls back to "attachment" for empty/degenerate names', () => {
    expect(sanitizeFilename(undefined)).toBe('attachment');
    expect(sanitizeFilename('   ')).toBe('attachment');
  });
});

describe('sanitizeContentType', () => {
  it('sanitizes and defaults', () => {
    expect(sanitizeContentType('application/pdf')).toBe('application/pdf');
    expect(sanitizeContentType(undefined)).toBe('application/octet-stream');
    expect(sanitizeContentType('a\r\nb')).toBe('a b');
  });
});

const addr = (value: AddressObject['value']): AddressObject => ({ value, html: '', text: '' });

describe('normalizeAddressList', () => {
  it('flattens addresses and drops empty ones', () => {
    expect(
      normalizeAddressList(
        addr([
          { address: 'a@x.com', name: '' },
          { address: '', name: 'no addr' },
        ]),
      ),
    ).toEqual(['a@x.com']);
  });

  it('flattens group addresses', () => {
    const grouped = addr([{ name: 'Team', group: [{ address: 'g@x.com', name: '' }] }]);
    expect(normalizeAddressList(grouped)).toEqual(['g@x.com']);
  });

  it('caps the number of retained addresses (recipient-stuffing guard)', () => {
    const many = addr(
      Array.from({ length: 500 }, (_, i) => ({ address: `u${i}@x.com`, name: '' })),
    );
    expect(normalizeAddressList(many).length).toBeLessThanOrEqual(50);
  });

  it('returns [] for undefined', () => {
    expect(normalizeAddressList(undefined)).toEqual([]);
  });
});

describe('normalizeFrom', () => {
  it('extracts the first address + sanitized display name', () => {
    expect(normalizeFrom(addr([{ address: 'a@x.com', name: 'Alice\r\nInjected' }]))).toEqual({
      from: 'a@x.com',
      fromName: 'Alice Injected',
    });
  });

  it('omits fromName when absent', () => {
    expect(normalizeFrom(addr([{ address: 'a@x.com', name: '' }]))).toEqual({ from: 'a@x.com' });
  });
});

describe('snippetFromText', () => {
  it('caps + sanitizes a plain-text body', () => {
    expect(snippetFromText('hello\r\nworld')).toBe('hello world');
    expect(snippetFromText('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe('snippetFromHtml', () => {
  it('reduces HTML to safe text via a real parser (tags removed, entities decoded)', () => {
    const snip = snippetFromHtml('<p>Hello&nbsp;<b>world</b> &amp; goodbye</p>');
    expect(snip).toContain('Hello');
    expect(snip).toContain('world');
    expect(snip).toContain('&'); // &amp; decoded, not left as an entity
    expect(snip).not.toContain('<');
    expect(snip).not.toContain('&amp;');
  });

  it('handles malformed / nested markup without leaking tags', () => {
    const snip = snippetFromHtml('<div><span>unclosed <b>bold <script>x=1</script>');
    expect(snip).not.toContain('<');
    expect(snip).not.toContain('script');
  });

  it('bounds huge HTML input before parsing (caps output)', () => {
    const huge = '<p>' + 'a'.repeat(2 * 1024 * 1024) + '</p>';
    expect(snippetFromHtml(huge).length).toBeLessThanOrEqual(300);
  });

  it('returns empty for undefined', () => {
    expect(snippetFromHtml(undefined)).toBe('');
  });
});
