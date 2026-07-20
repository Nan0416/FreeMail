import { useMemo } from 'react';
import { buildEmailSrcdoc } from '../lib/sanitize-email.js';

export interface EmailBodyFrameProps {
  /** Raw inbound HTML (as returned by the API); sanitized + sandboxed here. */
  readonly html: string;
  /** Whether to permit remote images (the "show images" toggle). Default-off blocks trackers. */
  readonly allowImages: boolean;
}

/**
 * Render untrusted inbound HTML inside a locked-down `srcdoc` iframe. The sandbox has NO
 * `allow-same-origin` (opaque origin → the email cannot touch the app's DOM/storage) and
 * NO `allow-scripts`/`allow-forms`; only `allow-popups(-to-escape-sandbox)` so a
 * user-clicked link opens a real new tab. The document itself is DOMPurify-sanitized and
 * carries its own per-email CSP (see {@link buildEmailSrcdoc}). With no `allow-scripts`,
 * the frame cannot self-size (postMessage would need scripts), so it fills a fixed pane
 * and scrolls internally — the correct script-free sizing.
 */
export function EmailBodyFrame({ html, allowImages }: EmailBodyFrameProps): React.JSX.Element {
  const srcDoc = useMemo(() => buildEmailSrcdoc(html, { allowImages }), [html, allowImages]);
  return (
    <iframe
      className="email-frame"
      title="Email content"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}
