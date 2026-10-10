import { cn } from '@/lib/utils';

/** A keyboard-shortcut hint. Decorative: the shortcut is also reachable by the control itself. */
export function Kbd(props: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground',
        props.className,
      )}
    >
      {props.children}
    </kbd>
  );
}
