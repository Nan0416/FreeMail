import { describe, expect, it } from 'vitest';
import { contentDispositionForDownload } from './content-disposition.js';

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
});
