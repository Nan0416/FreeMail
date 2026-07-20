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

describe('sanitizeEmailHtml — links', () => {
  it('forces target=_blank and rel=noopener noreferrer on every link', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">visit</a>', { allowImages: true });
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('https://example.com');
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
