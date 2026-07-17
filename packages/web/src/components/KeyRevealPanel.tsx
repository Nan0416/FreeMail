import { useState } from 'react';

export interface KeyRevealPanelProps {
  /** The raw `fm_…` key, shown exactly once. */
  apiKey: string;
  /** Dismiss — the parent clears the secret from state, unmounting this panel. */
  onDismiss: () => void;
}

/**
 * One-time reveal of a freshly created API key. The raw key is only ever the
 * `apiKey` prop (transient parent state); this component neither persists nor logs
 * it. Copy puts it on the OS clipboard — we say so plainly and make no attempt to
 * auto-clear the clipboard (a false sense of security; the OS owns it).
 */
export function KeyRevealPanel({ apiKey, onDismiss }: KeyRevealPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(apiKey);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the key is still shown for manual copy.
      setCopied(false);
    }
  }

  return (
    <div className="reveal-panel" role="alertdialog" aria-label="New API key">
      <h3>Copy your new API key now</h3>
      <p className="warn">
        This is the only time it will be shown. If you lose it, revoke it and create a new one.
      </p>
      <code className="secret" data-testid="revealed-key">
        {apiKey}
      </code>
      <div className="reveal-actions">
        <button type="button" onClick={() => void onCopy()}>
          {copied ? 'Copied to clipboard' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss}>
          I&apos;ve saved it
        </button>
      </div>
      <p className="hint">Copying places the key on your operating system clipboard.</p>
    </div>
  );
}
