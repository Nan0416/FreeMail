import { useCallback, useEffect, useState } from 'react';
import { MAX_API_KEY_NAME_LENGTH, type ApiKeySummary } from '@freemail/shared';
import { KeyRound, Menu } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { formatLongDate } from '../lib/format.js';
import { KeyRevealPanel } from './KeyRevealPanel.js';

export interface KeysViewProps {
  /** Shown below `lg`, where the sidebar collapses into a sheet. */
  readonly onOpenNav?: () => void;
}

export function KeysView(props: KeysViewProps): React.JSX.Element {
  const auth = useAuth();
  const [keys, setKeys] = useState<readonly ApiKeySummary[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  // The raw secret, held ONLY here, transiently, and shown exactly once. Never
  // persisted, never logged, never stored in the `keys` list.
  const [revealed, setRevealed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await auth.client.listKeys();
      setKeys(response.keys);
    } catch (err) {
      setKeys([]);
      setError(err instanceof ApiError ? err.message : 'Could not load API keys.');
    }
  }, [auth.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Belt-and-suspenders: drop the secret from state on unmount (navigating away / logout
  // both unmount this view), so it cannot outlive the moment it was shown.
  useEffect(() => () => setRevealed(null), []);

  async function onCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await auth.client.createKey(name.trim() || undefined);
      // Keep ONLY the raw string; put just the summary fields into the list.
      setRevealed(created.key);
      setKeys((prev) => [
        { id: created.id, name: created.name, createdAt: created.createdAt },
        ...(prev ?? []),
      ]);
      setName('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the API key.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(key: ApiKeySummary): Promise<void> {
    setError(null);
    setRevoking(null);
    try {
      await auth.client.revokeKey(key.id);
      setKeys((prev) => (prev ?? []).filter((k) => k.id !== key.id));
      toast.success('API key revoked');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the API key.');
    }
  }

  return (
    <section aria-label="API keys" className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        {props.onOpenNav && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={props.onOpenNav}
          >
            <Menu />
          </Button>
        )}
        <h1 className="text-[15px] font-semibold tracking-tight">API keys</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            API keys let your agents send and read email through the MCP server. A key grants full
            agent access and is shown once, when it is created.
          </p>

          {revealed && (
            <div className="mt-6">
              <KeyRevealPanel apiKey={revealed} onDismiss={() => setRevealed(null)} />
            </div>
          )}

          <form
            onSubmit={onCreate}
            aria-label="Create API key"
            className="mt-6 flex items-end gap-2"
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="key-name" className="text-xs text-muted-foreground">
                Name (optional)
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_API_KEY_NAME_LENGTH}
                placeholder="e.g. my-agent"
                className="h-8 text-[13px] shadow-none"
              />
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Creating…' : 'Create key'}
            </Button>
          </form>

          {error && (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {error}
            </p>
          )}

          <div className="mt-8 rounded-md border">
            {keys === null ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Loading…</p>
            ) : keys.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <KeyRound className="size-7 text-muted-foreground/50" strokeWidth={1.5} />
                <p className="mt-3 text-[13px] text-muted-foreground">No API keys yet.</p>
              </div>
            ) : (
              <ul aria-label="API keys" className="divide-y">
                {keys.map((key) => (
                  <li key={key.id} className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {key.name ?? 'Unnamed key'}
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span className="font-mono">{key.id}</span>
                        <span>Created {formatLongDate(key.createdAt)}</span>
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRevoking(key)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name ?? 'this key'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any agent using it stops working immediately. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => revoking && void onRevoke(revoking)}
            >
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
