import { describe, expect, it } from 'vitest';
import { buildEmailSrcdoc, sanitizeEmailHtml } from '../../src/lib/sanitize-email.js';

/**
 * Adversarial probes for the DOMPurify + srcdoc-CSP controls. Green happy-path rendering
 * does NOT clear this surface — every hostile input below must be neutralized, and the
 * two image-blocking layers (stripped `src` + CSP `img-src 'none'`) must BOTH hold.
 */
describe('sanitizeEmailHtml — hostile input', () => {
  it('strips <script> entirely', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>', { allowImages: true });
    expect(out).toContain('hi');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    const out = sanitizeEmailHtml('<img src="https://x/y.png" onerror="alert(1)">', {
      allowImages: true,
    });
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('keeps scheme-less layout attributes on tables and images', () => {
    // DOMPurify checks ALLOWED_URI_REGEXP against these values too; requiring a scheme
    // stripped them and collapsed table-based email layouts.
    const out = sanitizeEmailHtml(
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff">' +
        '<tr><td align="center" valign="top"><img src="https://x.test/a.png" width="32" height="32"></td></tr></table>',
      { allowImages: true },
    );
    for (const attr of [
      'width="100%"',
      'cellpadding="0"',
      'cellspacing="0"',
      'border="0"',
      'bgcolor="#fff"',
      'align="center"',
      'valign="top"',
      'width="32"',
      'height="32"',
    ]) {
      expect(out).toContain(attr);
    }
  });

  it('still drops dangerous schemes in any attribute and case', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:x',
      'data:text/html,x',
      'cid:part1',
      'file:///etc/passwd',
    ]) {
      const out = sanitizeEmailHtml(`<a href="${value}">x</a>`, { allowImages: true });
      expect(out).not.toContain('href=');
    }
  });

  it('drops a javascript: href', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>', { allowImages: true });
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('drops a data: href and a data: image src', () => {
    const href = sanitizeEmailHtml('<a href="data:text/html,<b>x</b>">x</a>', {
      allowImages: true,
    });
    expect(href).not.toContain('data:');
    const img = sanitizeEmailHtml('<img src="data:image/png;base64,AAAA">', { allowImages: true });
    expect(img).not.toContain('data:');
  });

  it('removes form / input phishing surface', () => {
    const out = sanitizeEmailHtml('<form action="https://evil"><input name="pw"></form>', {
      allowImages: true,
    });
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });

  it('strips dangerous CSS from a style attribute but keeps benign styling', () => {
    const dangerous = sanitizeEmailHtml('<p style="width:expression(alert(1))">x</p>', {
      allowImages: true,
    });
    expect(dangerous.toLowerCase()).not.toContain('expression');

    const benign = sanitizeEmailHtml('<p style="color:red">x</p>', { allowImages: true });
    expect(benign.toLowerCase()).toContain('color');
    expect(benign.toLowerCase()).toContain('red');
  });

  it('drops a @import in a style attribute', () => {
    const out = sanitizeEmailHtml('<p style="background:url(x);@import url(evil)">x</p>', {
      allowImages: true,
    });
    expect(out.toLowerCase()).not.toContain('@import');
  });
});

/** The single `<a>` or `<area>` in a sanitized fragment, parsed back into a DOM. */
function onlyLink(html: string): Element {
  const links = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a, area');
  expect(links).toHaveLength(1);
  return links[0]!;
}

describe('sanitizeEmailHtml — links', () => {
  it('forces target=_blank and rel=noopener noreferrer on every link', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">visit</a>', { allowImages: true });
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('https://example.com');
  });

  it('drops every href that would resolve against the app page', () => {
    // The reader's srcdoc iframe inherits the app page's base URL, so each of these would
    // open a page on the app's own origin.
    for (const href of [
      '/',
      '/account/settings',
      'unsubscribe',
      '../outside',
      './page.html',
      '?q=relative-query',
      'www.example.com',
      'example.com/pricing',
      '',
      ' /padded ',
      // Same scheme as the https: app page, so the browser resolves these relative to it.
      'https:account/settings',
      'HTTPS:/account/settings',
    ]) {
      const link = onlyLink(
        sanitizeEmailHtml(`<a href="${href}" target="_top">x</a>`, { allowImages: true }),
      );
      expect(link.hasAttribute('href'), href).toBe(false);
      expect(link.hasAttribute('target'), href).toBe(false);
      expect(link.textContent).toBe('x');
    }
  });

  it('writes absolute links back fully resolved', () => {
    for (const [href, expected] of [
      ['https://example.com/a b', 'https://example.com/a%20b'],
      ['  HTTPS://Example.com/x  ', 'https://example.com/x'],
      ['http://example.com', 'http://example.com/'],
      // Protocol-relative names its own host, like the https: app page would resolve it.
      ['//example.com/protocol-relative', 'https://example.com/protocol-relative'],
      // `http:` differs from the app page's scheme, so it is not relative to it.
      ['http:example.com', 'http://example.com/'],
      ['mailto:test@example.com', 'mailto:test@example.com'],
      ['tel:+15551234567', 'tel:+15551234567'],
    ] as const) {
      const link = onlyLink(sanitizeEmailHtml(`<a href="${href}">x</a>`, { allowImages: true }));
      expect(link.getAttribute('href'), href).toBe(expected);
      expect(link.getAttribute('target'), href).toBe('_blank');
      expect(link.getAttribute('rel'), href).toBe('noopener noreferrer');
    }
  });

  it('points a #fragment link at the iframe itself so it scrolls the email', () => {
    for (const [href, expected] of [
      ['#section-2', 'about:srcdoc#section-2'],
      [' #padded ', 'about:srcdoc#padded'],
      ['#', 'about:srcdoc#'],
    ] as const) {
      const link = onlyLink(sanitizeEmailHtml(`<a href="${href}">x</a>`, { allowImages: true }));
      expect(link.getAttribute('href'), href).toBe(expected);
      // Overrides the document's <base target="_blank">.
      expect(link.getAttribute('target'), href).toBe('_self');
    }
  });

  it('applies the same rules to image-map areas', () => {
    const relative = onlyLink(
      sanitizeEmailHtml('<map name="m"><area href="/account" alt="a"></map>', {
        allowImages: true,
      }),
    );
    expect(relative.hasAttribute('href')).toBe(false);

    const absolute = onlyLink(
      sanitizeEmailHtml('<map name="m"><area href="https://example.com/x" alt="a"></map>', {
        allowImages: true,
      }),
    );
    expect(absolute.getAttribute('href')).toBe('https://example.com/x');
    expect(absolute.getAttribute('target')).toBe('_blank');
    expect(absolute.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves a link with no href alone', () => {
    const link = onlyLink(sanitizeEmailHtml('<a name="top">x</a>', { allowImages: true }));
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.hasAttribute('target')).toBe(false);
  });
});

describe('sanitizeEmailHtml — image blocking (layer 1: stripped src)', () => {
  const TRACKER =
    '<img src="https://tracker.example/pixel.png?uid=1" srcset="https://tracker.example/2x.png 2x">';

  it('strips remote image loaders by default', () => {
    const out = sanitizeEmailHtml(TRACKER, { allowImages: false });
    expect(out).not.toContain('tracker.example');
    expect(out.toLowerCase()).not.toContain('srcset');
  });

  it('keeps the https image src when images are allowed (but never srcset)', () => {
    const out = sanitizeEmailHtml(TRACKER, { allowImages: true });
    expect(out).toContain('https://tracker.example/pixel.png');
    // srcset is always dropped so only the CSP-governed single src can load.
    expect(out.toLowerCase()).not.toContain('srcset');
  });

  it('strips a legacy background image loader when blocked', () => {
    const out = sanitizeEmailHtml('<td background="https://tracker.example/bg.png">x</td>', {
      allowImages: false,
    });
    expect(out).not.toContain('tracker.example');
  });

  it('never loads an image from the app page, even when images are allowed', () => {
    for (const src of ['/logo.png', 'logo.png', 'https:logo.png', '?x=1']) {
      const out = sanitizeEmailHtml(
        `<img src="${src}"><table><tr><td background="${src}">x</td></tr></table>`,
        { allowImages: true },
      );
      expect(out, src).not.toContain('src=');
      expect(out, src).not.toContain('background=');
    }
  });

  it('writes an allowed image source back fully resolved', () => {
    const out = sanitizeEmailHtml('<img src="//cdn.example/a b.png">', { allowImages: true });
    expect(out).toContain('src="https://cdn.example/a%20b.png"');
  });
});

describe('buildEmailSrcdoc — per-email CSP (layer 2)', () => {
  it('is a full document with a first-in-head CSP that blocks images by default', () => {
    const doc = buildEmailSrcdoc('<p>hi</p>', { allowImages: false });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src 'none'");
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('hi');
  });

  it('relaxes ONLY img-src to https when images are shown', () => {
    const doc = buildEmailSrcdoc('<p>hi</p>', { allowImages: true });
    expect(doc).toContain('img-src https:');
    expect(doc).not.toContain("img-src 'none'");
    // default-src stays locked; scripts never allowed.
    expect(doc).toContain("default-src 'none'");
  });

  it('both layers hold: a tracker is src-stripped AND the CSP forbids images when blocked', () => {
    const doc = buildEmailSrcdoc('<img src="https://tracker.example/pixel.png">', {
      allowImages: false,
    });
    expect(doc).not.toContain('tracker.example');
    expect(doc).toContain("img-src 'none'");
  });
});
