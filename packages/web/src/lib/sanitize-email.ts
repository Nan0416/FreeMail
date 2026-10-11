import DOMPurify from 'dompurify';

/**
 * Untrusted-inbound-HTML rendering. This is TWO of the four independent controls the
 * reader stacks (the iframe `sandbox` and the app CSP are the other two):
 *
 *  1. **DOMPurify** strips scripts, event handlers, dangerous URI schemes
 *     (`javascript:`/`data:`/…), dangerous CSS, and unsafe tags, forces safe link
 *     attributes, and drops every link and image URL that would resolve against the app
 *     page (see {@link STAND_IN_BASE}).
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

/**
 * Only these schemes may appear in an attribute value. Blocks `javascript:`, `data:`,
 * `vbscript:`, `cid:`, `file:`, … DOMPurify tests this against EVERY attribute it does not
 * deem URI-safe — `width`, `align`, `cellpadding`, `bgcolor`, … — not just URLs, so
 * scheme-less values must pass too (this is DOMPurify's default pattern, narrowed to our
 * schemes). Requiring a scheme stripped all table/image layout attributes.
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/**
 * Stand-in base for resolving an email's URLs. A `srcdoc` document's base URL is its
 * parent's — here the app page itself — and the app CSP's `base-uri 'none'` forbids
 * overriding it, so any URL without its own origin (`/settings`, `unsubscribe`, `?q=1`,
 * a scheme-less `www.example.com`, even `https:foo`) would open a page on the app's origin.
 * Resolved against this base instead — `https:` like the app, so `https:foo` resolves the
 * same way — such a URL lands on {@link STAND_IN_ORIGIN} and is dropped. A URL that
 * survives is written back absolute, so the browser cannot resolve it any differently.
 */
const STAND_IN_BASE = 'https://email-base.invalid/';
const STAND_IN_ORIGIN = new URL(STAND_IN_BASE).origin;

/** Schemes a surviving link may navigate to. */
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Schemes a surviving image source may load from (when images are allowed). */
const RESOURCE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** `value` resolved against {@link STAND_IN_BASE}, or `undefined` if it does not parse. */
function resolveEmailUrl(value: string): URL | undefined {
  try {
    return new URL(value, STAND_IN_BASE);
  } catch {
    return undefined;
  }
}

/**
 * `value` as an absolute URL with one of `protocols`, or `undefined` if it is relative to
 * the page, does not parse, or has another scheme. A protocol-relative `//host/path` names
 * its own host, so it counts as absolute (`https:`).
 */
function toAbsoluteUrl(value: string, protocols: ReadonlySet<string>): string | undefined {
  const url = resolveEmailUrl(value);
  if (url === undefined || url.origin === STAND_IN_ORIGIN || !protocols.has(url.protocol)) {
    return undefined;
  }
  return url.href;
}

/**
 * Make one `<a>` / `<area>` safe to click from the reader's iframe. An absolute link is
 * written back resolved and opens in a fresh, non-opener tab. A `#fragment` link targets
 * the iframe's own `about:srcdoc` URL, so it scrolls the email instead of opening the app
 * page with that fragment. Any other link would open a page on the app's origin, so it
 * loses its `href` and renders as plain text.
 */
function rewriteLink(node: Element): void {
  const href = node.getAttribute('href');
  if (href === null) {
    return;
  }
  const absolute = toAbsoluteUrl(href, LINK_PROTOCOLS);
  if (absolute !== undefined) {
    node.setAttribute('href', absolute);
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  const url = resolveEmailUrl(href);
  if (url !== undefined && href.trim().startsWith('#')) {
    // An empty fragment (`href="#"`) still needs its `#`: plain `about:srcdoc` would
    // navigate the iframe away from the email instead of scrolling it.
    node.setAttribute('href', `about:srcdoc${url.hash || '#'}`);
    node.setAttribute('target', '_self');
    return;
  }
  node.removeAttribute('href');
  node.removeAttribute('target');
}

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

/** Single-URL resource loaders. Kept only for absolute `https?:` when images are allowed, else stripped. */
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

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' || node.nodeName === 'AREA') {
      rewriteLink(node);
    }
    // Block remote resources by default; even when images are allowed, keep ONLY an
    // absolute `https?:` src (strip `data:`/`cid:`/other schemes DOMPurify treats as safe
    // on img, and any URL that would load from the app's origin). Belt for the per-email
    // CSP `img-src 'none' | https:`.
    for (const attr of RESOURCE_ATTRS) {
      const value = node.getAttribute(attr);
      if (value === null) {
        continue;
      }
      const absolute = currentAllowImages ? toAbsoluteUrl(value, RESOURCE_PROTOCOLS) : undefined;
      if (absolute === undefined) {
        node.removeAttribute(attr);
      } else {
        node.setAttribute(attr, absolute);
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

/**
 * Light reset for the isolated email document, matching the reading pane: the body column
 * is centred at the same max width as the pane's header, so the iframe can span the full
 * pane (its scrollbar sits at the pane edge) while the text keeps a readable measure.
 * Fonts are system-only: the per-email CSP (`default-src 'none'`) loads no web fonts.
 */
const IFRAME_RESET_CSS =
  'html{background:#fff;}' +
  'body{margin:0 auto;max-width:768px;padding:4px 32px 40px;box-sizing:border-box;' +
  'color:#2a2a31;background:#fff;' +
  "font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
  'font-size:14px;line-height:1.6;overflow-wrap:break-word;}' +
  'a[href]{color:#4752c4;}img{max-width:100%;height:auto;}' +
  'table{max-width:100%;}' +
  'blockquote{margin:0 0 0 .25rem;padding-left:.75rem;border-left:2px solid #e4e4e7;color:#63636e;}' +
  'pre{white-space:pre-wrap;}' +
  '@media (max-width:767px){body{padding:4px 20px 32px;}}';

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
