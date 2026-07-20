import DOMPurify from 'dompurify';

/**
 * Untrusted-inbound-HTML rendering. This is TWO of the four independent controls the
 * reader stacks (the iframe `sandbox` and the app CSP are the other two):
 *
 *  1. **DOMPurify** strips scripts, event handlers, dangerous URI schemes
 *     (`javascript:`/`data:`/…), dangerous CSS, and unsafe tags, and forces safe link
 *     attributes.
 *  2. **A per-email `<meta>` CSP** injected into the built document independently locks
 *     the opaque-origin doc: `default-src 'none'` so nothing loads, and `img-src` is
 *     `'none'` by default (blocking tracking pixels / beacons) → `https:` only when the
 *     user opts into "show images".
 *
 * The output is only ever fed to a `srcdoc` iframe rendered with
 * `sandbox="allow-popups allow-popups-to-escape-sandbox"` (NEVER `allow-same-origin` /
 * `allow-scripts` / `allow-forms`) — see {@link EmailBodyFrame}. No single control is
 * trusted alone; each independently contains a miss in the others.
 */

/** Only these schemes may appear in any URI attribute (`href`, `src`, …). Blocks `javascript:`, `data:`, `vbscript:`, `cid:`, `file:`, … */
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|tel:)/i;

/**
 * Tags removed outright — active content, embedding, form/phishing surface, and CSS/SVG
 * vectors. `<script>` is removed by DOMPurify regardless; the rest are belt-and-braces
 * (the sandbox already blocks scripts/forms, and the per-email CSP blocks subresources).
 */
const FORBIDDEN_TAGS = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'meta',
  'title',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'portal',
];

/**
 * Attributes removed outright. Event handlers are stripped by DOMPurify; `srcset` is
 * dropped always so only a single, CSP-governed `src` can ever load (a multi-candidate
 * srcset is harder to reason about against `img-src`).
 */
const FORBIDDEN_ATTRS = ['ping', 'formaction', 'srcset'];

/** Declarations that make a `style` value dangerous (legacy script-in-CSS + remote CSS import). */
const DANGEROUS_CSS = /expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i;

/** Single-URL resource loaders. Kept only for `https?:` when images are allowed, else stripped. */
const RESOURCE_ATTRS = ['src', 'background', 'poster'];

/**
 * Per-call flag the (global) DOMPurify hooks read to decide whether to keep image
 * sources. `sanitizeEmailHtml` is synchronous, so setting it around the single
 * `sanitize` call is race-free in JS's single thread.
 */
let currentAllowImages = false;

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  // Force every surviving link to open in a fresh, non-opener tab.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    // Block remote resources by default; even when images are allowed, keep ONLY an
    // `https?:` src (strip `data:`/`cid:`/other schemes DOMPurify treats as safe on img).
    // Belt for the per-email CSP `img-src 'none' | https:`.
    for (const attr of RESOURCE_ATTRS) {
      if (!node.hasAttribute(attr)) {
        continue;
      }
      const value = node.getAttribute(attr) ?? '';
      if (!currentAllowImages || !/^\s*https?:/i.test(value)) {
        node.removeAttribute(attr);
      }
    }
  });

  // Drop a whole `style` attribute containing dangerous CSS (rather than trust a partial parse).
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && DANGEROUS_CSS.test(data.attrValue)) {
      data.keepAttr = false;
    }
  });
}

export interface SanitizeOptions {
  /** When false (default), remote images are blocked (loader attributes stripped). */
  readonly allowImages: boolean;
}

/** Sanitize an inbound HTML body to a safe fragment string. */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions): string {
  installHooks();
  currentAllowImages = opts.allowImages;
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_URI_REGEXP,
      FORBID_TAGS: FORBIDDEN_TAGS,
      FORBID_ATTR: FORBIDDEN_ATTRS,
      ADD_ATTR: ['target'],
      ALLOW_DATA_ATTR: false,
      // A fragment; we wrap it in our own trusted document below.
      WHOLE_DOCUMENT: false,
    });
  } finally {
    currentAllowImages = false;
  }
}

/** Minimal dark-theme reset for the isolated email document (matches the app palette). */
const IFRAME_RESET_CSS =
  'html,body{margin:0;padding:12px;color:#e2e8f0;background:#0f172a;' +
  "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
  'font-size:14px;line-height:1.5;word-break:break-word;overflow-wrap:anywhere;}' +
  'a{color:#38bdf8;}img{max-width:100%;height:auto;}' +
  'table{max-width:100%;}blockquote{margin:0 0 0 1rem;padding-left:1rem;border-left:2px solid #334155;}';

/**
 * Build the full `srcdoc` document for the reader iframe: the sanitized body wrapped in
 * a trusted shell whose FIRST head entry is a per-email CSP. The CSP is the independent
 * second lock — `default-src 'none'` (no subresources at all) and `img-src` gated on the
 * caller's image preference. `<base target="_blank">` backstops link targeting.
 */
export function buildEmailSrcdoc(html: string, opts: SanitizeOptions): string {
  const body = sanitizeEmailHtml(html, opts);
  const imgSrc = opts.allowImages ? 'https:' : "'none'";
  const csp = [`default-src 'none'`, `img-src ${imgSrc}`, `style-src 'unsafe-inline'`].join('; ');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<base target="_blank">' +
    `<style>${IFRAME_RESET_CSS}</style>` +
    `</head><body>${body}</body></html>`
  );
}
