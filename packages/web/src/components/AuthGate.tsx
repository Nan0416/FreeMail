import { useAuth } from '../auth/auth-context.js';
import { AppShell } from './AppShell.js';
import { AuthScreen } from './AuthScreen.js';
import { SignInView } from './SignInView.js';

export interface AuthGateProps {
  /** Deploy-time inbound flag, threaded to the shell to gate the Inbox tab. */
  readonly inboundEnabled?: boolean;
}

/** Route between the sign-in screen and the app based on auth status. */
export function AuthGate(props: AuthGateProps): React.JSX.Element {
  const auth = useAuth();
  if (auth.status === 'loading') {
    return (
      <AuthScreen>
        <p className="text-center text-[13px] text-muted-foreground">Loading…</p>
      </AuthScreen>
    );
  }
  return auth.status === 'authenticated' ? (
    <AppShell inboundEnabled={props.inboundEnabled ?? false} />
  ) : (
    <SignInView />
  );
}
