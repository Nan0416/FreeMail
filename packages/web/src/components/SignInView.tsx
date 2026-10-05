import { useState } from 'react';
import { MIN_PASSWORD_LENGTH } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthScreen } from './AuthScreen.js';

/**
 * The unauthenticated gate — a single password form.
 *
 * There is no separate first-run screen: on a deployment with no password yet, the
 * login request ENROLLS the submitted password (#42 trust-on-first-use). The SPA has
 * no unauthenticated "is a password set?" probe and deliberately gains none — that
 * would tell any unauthenticated caller whether the account is still unclaimed — so
 * this form cannot distinguish the two cases, and states the consequence up front
 * instead of silently claiming the account on a mistyped first attempt.
 */
export function SignInView(): React.JSX.Element {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <div className="rounded-lg border bg-background p-6">
        <form onSubmit={onLogin} aria-label="Sign in" className="space-y-4">
          <div>
            <h1 className="text-[15px] font-semibold">Sign in</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Enter your password to continue.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-9 shadow-none"
            />
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy || password.length === 0}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
      <p className="mt-4 px-2 text-center text-xs leading-relaxed text-muted-foreground">
        First sign-in on a new deployment? The password you enter becomes your account password (at
        least {MIN_PASSWORD_LENGTH} characters) — type it carefully.
      </p>
    </AuthScreen>
  );
}
