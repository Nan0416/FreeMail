import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CopyButtonProps {
  /** What lands on the clipboard. */
  readonly text: string;
  /** Accessible name, e.g. "Copy server URL". */
  readonly label: string;
  readonly className?: string;
}

/** An icon button that copies `text`, showing a check for a moment once it has. */
export function CopyButton(props: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(props.text);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the text is on screen to copy by hand.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? 'Copied' : props.label}
      title={props.label}
      onClick={() => void onCopy()}
      className={cn('text-muted-foreground hover:text-foreground', props.className)}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
