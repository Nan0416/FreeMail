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
import { CopyButton } from './CopyButton.js';
import { KeyRevealPanel } from './KeyRevealPanel.js';

export interface McpServerViewProps {
  /** Shown below `lg`, where the sidebar collapses into a sheet. */
  readonly onOpenNav?: () => void;
}

/** The environment variable the `.mcp.json` sample reads the access key from. */
const KEY_ENV_VAR = 'FREEMAIL_API_KEY';

/**
 * A project `.mcp.json` that connects Claude Code to this server. The key is an environment
 * reference, which Claude Code expands when it loads the file, so the secret never sits in a
 * file that may be committed.
 */
export function mcpJson(serverUrl: string): string {
  const config = {
    mcpServers: {
      freemail: {
        type: 'http',
        url: serverUrl,
        headers: { 'x-api-key': `\${${KEY_ENV_VAR}}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Everything an agent needs to reach the MCP server: its URL, a ready-to-paste Claude Code
 * config, and the access keys agents authenticate with (`x-api-key`).
 */
export function McpServerView(props: McpServerViewProps): React.JSX.Element {
  const auth = useAuth();
  // Absolute even under `vite dev`, whose API base is the same-origin `/api` proxy.
  const serverUrl = new URL(`${auth.client.baseUrl}/mcp`, window.location.href).href;
  const config = mcpJson(serverUrl);
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
      setError(err instanceof ApiError ? err.message : 'Could not load access keys.');
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
      setError(err instanceof ApiError ? err.message : 'Could not create the access key.');
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
      toast.success('Access key revoked');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the access key.');
    }
  }

  return (
    <section aria-label="MCP server" className="flex h-full min-w-0 flex-col">
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
        <h1 className="text-[15px] font-semibold tracking-tight">MCP server</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-8">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Connect an AI agent to your mailbox. Through this MCP server it can send email and read
            your mail, as you.
          </p>

          <h2 className="mt-8 text-[13px] font-semibold">Server URL</h2>
          <div className="mt-2 flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code
              data-testid="mcp-server-url"
              className="min-w-0 flex-1 truncate font-mono text-xs select-all"
            >
              {serverUrl}
            </code>
            <CopyButton text={serverUrl} label="Copy server URL" />
          </div>

          <h2 className="mt-8 text-[13px] font-semibold">Use it from Claude Code</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Save this as <code className="font-mono text-xs text-foreground">.mcp.json</code> in
            your project&rsquo;s root. Claude Code fills in the key from the{' '}
            <code className="font-mono text-xs text-foreground">{KEY_ENV_VAR}</code> environment
            variable, so the key itself never sits in the file.
          </p>
          <div className="relative mt-2">
            <pre
              data-testid="mcp-json"
              className="overflow-x-auto rounded-md border bg-muted/40 py-2.5 pr-10 pl-3 font-mono text-xs leading-relaxed"
            >
              {config}
            </pre>
            <CopyButton
              text={config}
              label="Copy .mcp.json"
              className="absolute top-1.5 right-1.5"
            />
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Then set the key in the shell you start Claude from:
          </p>
          <div className="mt-2 flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">
              export {KEY_ENV_VAR}=fm_…
            </code>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Any other MCP client works the same way: point it at the server URL (Streamable HTTP)
            and send the key in an{' '}
            <code className="font-mono text-xs text-foreground">x-api-key</code> header.
          </p>

          <h2 className="mt-8 text-[13px] font-semibold">Access keys</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            A key gives an agent full access to your mail. It is shown once, when you create it;
            revoke it to cut that agent off.
          </p>

          {revealed && (
            <div className="mt-4">
              <KeyRevealPanel apiKey={revealed} onDismiss={() => setRevealed(null)} />
            </div>
          )}

          <form
            onSubmit={onCreate}
            aria-label="Create access key"
            className="mt-4 flex items-end gap-2"
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

          <div className="mt-4 rounded-md border">
            {keys === null ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Loading…</p>
            ) : keys.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <KeyRound className="size-7 text-muted-foreground/50" strokeWidth={1.5} />
                <p className="mt-3 text-[13px] text-muted-foreground">No access keys yet.</p>
              </div>
            ) : (
              <ul aria-label="Access keys" className="divide-y">
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
