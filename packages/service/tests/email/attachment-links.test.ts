import { describe, expect, it } from 'vitest';
import {
  appendDownloadLinks,
  escapeHtml,
  formatBytes,
  type DownloadLink,
} from '../../src/email/attachment-links.js';

function link(overrides: Partial<DownloadLink> = {}): DownloadLink {
  return {
    filename: 'report.pdf',
    sizeBytes: 5 * 1024 * 1024,
    url: 'https://api.example.com/d/tok123',
    ...overrides,
  };
}

describe('appendDownloadLinks', () => {
  it('returns the body unchanged when there are no links', () => {
    const body = { text: 'hi', html: '<p>hi</p>' };
    expect(appendDownloadLinks(body, [])).toEqual(body);
  });

  it('appends to the text body only when only text is present', () => {
    const result = appendDownloadLinks({ text: 'hello' }, [link()]);
    expect(result.html).toBeUndefined();
    expect(result.text).toContain('hello');
    expect(result.text).toContain('report.pdf');
    expect(result.text).toContain('https://api.example.com/d/tok123');
    expect(result.text).toContain('available for 30 days');
  });

  it('appends to the html body only when only html is present', () => {
    const result = appendDownloadLinks({ html: '<p>hello</p>' }, [link()]);
    expect(result.text).toBeUndefined();
    expect(result.html).toContain('<p>hello</p>');
    expect(result.html).toContain('<a href="https://api.example.com/d/tok123">report.pdf</a>');
  });

  it('appends to both bodies when both are present, pluralizing for multiple links', () => {
    const result = appendDownloadLinks({ text: 't', html: '<p>h</p>' }, [
      link({ filename: 'a.pdf', url: 'https://api.example.com/d/a' }),
      link({ filename: 'b.zip', url: 'https://api.example.com/d/b' }),
    ]);
    expect(result.text).toContain('Large attachments (available for 30 days):');
    expect(result.html).toContain('Large attachments ');
    expect(result.text).toContain('a.pdf');
    expect(result.text).toContain('b.zip');
  });

  it('HTML-escapes an attacker-controlled filename so it cannot break out of the anchor', () => {
    const malicious = '"><img src=x onerror=alert(1)>.pdf';
    const result = appendDownloadLinks({ html: '<p>x</p>' }, [link({ filename: malicious })]);
    // The raw injection must not survive; the escaped form must.
    expect(result.html).not.toContain('<img src=x');
    expect(result.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.pdf');
  });

  it('strips control characters (incl. CR/LF) from a filename in the text block', () => {
    const result = appendDownloadLinks({ text: 'x' }, [
      link({ filename: 'evil\r\nBcc: victim@x.com.pdf' }),
    ]);
    expect(result.text).not.toContain('\r');
    expect(result.text).not.toContain('\n Bcc');
    expect(result.text).toContain('evilBcc: victim@x.com.pdf');
  });
});

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('formatBytes', () => {
  it('formats across unit boundaries', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(Math.round(4.8 * 1024 * 1024))).toBe('4.8 MB');
    expect(formatBytes(240 * 1024 * 1024)).toBe('240 MB');
  });
});
