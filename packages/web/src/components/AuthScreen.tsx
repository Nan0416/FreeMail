import { Mail } from 'lucide-react';

/** Centred frame shared by the boot, loading, and sign-in screens. */
export function AuthScreen(props: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <main className="grid min-h-full place-items-center bg-sidebar px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Mail className="size-4" strokeWidth={2.25} />
          </span>
          <span className="text-lg font-semibold tracking-tight">FreeMail</span>
        </div>
        {props.children}
      </div>
    </main>
  );
}
