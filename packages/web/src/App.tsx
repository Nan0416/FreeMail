import { useEffect, useState } from 'react';
import type { WebRuntimeConfig } from '@freemail/shared';
import { AuthProvider } from './auth/auth-context.js';
import { AuthGate } from './components/AuthGate.js';
import { loadRuntimeConfig } from './config/runtime-config.js';

type Boot =
  | { status: 'loading' }
  | { status: 'ready'; config: WebRuntimeConfig }
  | { status: 'error'; message: string };

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
  const { loadConfig = loadRuntimeConfig, fetchImpl } = props;
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
      <main className="auth-screen">
        <p className="muted">Starting FreeMail…</p>
      </main>
    );
  }
  if (boot.status === 'error') {
    return (
      <main className="auth-screen">
        <div className="card auth-card">
          <h1>FreeMail</h1>
          <p role="alert" className="error">
            {boot.message}
          </p>
        </div>
      </main>
    );
  }

  return (
    <AuthProvider apiBaseUrl={boot.config.apiBaseUrl} fetchImpl={fetchImpl}>
      <AuthGate />
    </AuthProvider>
  );
}
