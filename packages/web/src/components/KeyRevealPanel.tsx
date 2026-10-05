import { useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface KeyRevealPanelProps {
  /** The raw `fm_…` key, shown exactly once. */
  readonly apiKey: string;
  /** Dismiss — the parent clears the secret from state, unmounting this panel. */
  readonly onDismiss: () => void;
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
    <div
      role="alertdialog"
      aria-label="New API key"
      className="rounded-md border border-warning/30 bg-warning-surface p-4"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold">Copy your new API key now</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            This is the only time it will be shown. If you lose it, revoke it and create a new one.
          </p>
          <code
            data-testid="revealed-key"
            className="mt-3 block rounded border bg-background px-3 py-2 font-mono text-xs break-all select-all"
          >
            {apiKey}
          </code>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="bg-background"
              onClick={() => void onCopy()}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied to clipboard' : 'Copy'}
            </Button>
            <Button size="sm" onClick={onDismiss}>
              I&apos;ve saved it
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Copying places the key on your operating system clipboard.
          </p>
        </div>
      </div>
    </div>
  );
}
