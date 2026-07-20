import { describe, expect, it } from 'vitest';
import { contentDispositionForDownload } from '../../src/email/content-disposition.js';

describe('contentDispositionForDownload', () => {
  it('always forces attachment (never inline)', () => {
    expect(contentDispositionForDownload('report.pdf')).toMatch(/^attachment; /);
  });

  it('encodes a plain ASCII filename in both the fallback and filename*', () => {
    const value = contentDispositionForDownload('report.pdf');
    expect(value).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('percent-encodes UTF-8 in filename* and downgrades the ASCII fallback', () => {
    const value = contentDispositionForDownload('résumé.pdf');
    expect(value).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
    // Fallback keeps ASCII, replacing non-ASCII with '_'.
    expect(value).toContain('filename="r_sum_.pdf"');
  });

  it('percent-encodes the RFC 5987 non-attr chars (quote/paren/star)', () => {
    const value = contentDispositionForDownload(`a'(b)*.txt`);
    expect(value).toContain('%27'); // '
    expect(value).toContain('%28'); // (
    expect(value).toContain('%29'); // )
    expect(value).toContain('%2A'); // *
  });

  // The security-critical case: a hostile filename must NOT break out of the header.
  it('strips CR/LF/control chars — no header injection', () => {
    const hostile = 'evil"\r\nX-Injected: pwned\r\nContent-Type: text/html\x00.txt';
    const value = contentDispositionForDownload(hostile);
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).not.toContain('\x00');
    // The header name of the injected line must never appear as a raw header break-out.
    expect(value).not.toMatch(/\r?\n\s*X-Injected/i);
  });

  it('neutralizes a double-quote/backslash so the quoted-string cannot close early', () => {
    const value = contentDispositionForDownload('a"b\\c.txt');
    // Extract the quoted fallback and assert no stray quote/backslash inside it.
    const match = value.match(/filename="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('a_b_c.txt');
  });

  it('falls back to "download" for an empty / control-only / missing name', () => {
    expect(contentDispositionForDownload('')).toBe('attachment; filename="download"');
    expect(contentDispositionForDownload(undefined)).toBe('attachment; filename="download"');
    expect(contentDispositionForDownload('\r\n\t\x00')).toBe('attachment; filename="download"');
  });

  // encodeURIComponent throws URIError on a lone surrogate — a hostile filename must not 500.
  it('strips a pre-existing lone surrogate without throwing', () => {
    let value = '';
    expect(() => {
      value = contentDispositionForDownload('a\uD83Db.pdf'); // lone high surrogate
    }).not.toThrow();
    expect(value).toMatch(/^attachment; filename="/);
    expect(value).not.toContain('\uD83D');
    expect(value).toContain('filename="ab.pdf"');
  });

  it('does not throw on a lone low surrogate either', () => {
    expect(() => contentDispositionForDownload('x\uDE00y.pdf')).not.toThrow();
  });

  // A UTF-16-code-unit slice at 255 would split an emoji into a lone surrogate → URIError.
  it('does not split a surrogate pair (emoji) at the 255-char boundary', () => {
    // The emoji's first code unit lands at index 254; code-point slicing keeps it whole.
    const name = 'a'.repeat(254) + '😀' + 'tail.pdf';
    let value = '';
    expect(() => {
      value = contentDispositionForDownload(name);
    }).not.toThrow();
    // The full emoji survives in filename* as its percent-encoded UTF-8, not split.
    expect(value).toContain('%F0%9F%98%80');
  });

  it('encodes a normal emoji filename in filename*', () => {
    expect(contentDispositionForDownload('😀.pdf')).toContain(`filename*=UTF-8''%F0%9F%98%80.pdf`);
  });
});
