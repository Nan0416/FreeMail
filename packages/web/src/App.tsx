import { useEffect, useState } from 'react';
import type { WebRuntimeConfig } from '@freemail/shared';
import { AuthProvider } from './auth/auth-context.js';
import { AuthGate } from './components/AuthGate.js';
import { AuthScreen } from './components/AuthScreen.js';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { loadRuntimeConfig } from './config/runtime-config.js';

type Boot =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly config: WebRuntimeConfig }
  | { readonly status: 'error'; readonly message: string };

/**
 * Boots by loading the deploy-time runtime config (the API endpoint), then mounts
 * the auth provider + gate. `loadConfig`/`fetchImpl` are injectable so tests can
 * mount `App` against stubs.
 */
export function App(
  props: {
    loadConfig?: () => Promise<WebRuntimeConfig>;
    fetchImpl?: typeof fetch;
  } = {},
): React.JSX.Element {
  const loadConfig = props.loadConfig ?? loadRuntimeConfig;
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    loadConfig()
      .then((config) => {
        if (active) {
          setBoot({ status: 'ready', config });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setBoot({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to start.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [loadConfig]);

  if (boot.status === 'loading') {
    return (
      <AuthScreen>
        <p className="text-center text-[13px] text-muted-foreground">Starting FreeMail…</p>
      </AuthScreen>
    );
  }
  if (boot.status === 'error') {
    return (
      <AuthScreen>
        <p
          role="alert"
          className="rounded-lg border bg-background p-4 text-[13px] text-destructive"
        >
          {boot.message}
        </p>
      </AuthScreen>
    );
  }

  return (
    <AuthProvider apiBaseUrl={boot.config.apiBaseUrl} fetchImpl={props.fetchImpl}>
      <TooltipProvider delayDuration={400}>
        <AuthGate inboundEnabled={boot.config.inboundEnabled} />
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </AuthProvider>
  );
}
