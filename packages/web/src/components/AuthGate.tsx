import { useAuth } from '../auth/auth-context.js';
import { AppShell } from './AppShell.js';
import { SignInView } from './SignInView.js';

/** Route between the sign-in screen and the app based on auth status. */
export function AuthGate(): React.JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <main className="auth-screen">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  return status === 'authenticated' ? <AppShell /> : <SignInView />;
}
