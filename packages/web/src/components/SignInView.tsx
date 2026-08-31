import { useState } from 'react';
import { MIN_PASSWORD_LENGTH } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';

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
    <main className="auth-screen">
      <div className="card auth-card">
        <h1>FreeMail</h1>
        <form onSubmit={onLogin} aria-label="Sign in">
          <p className="muted">Enter your password to continue.</p>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <p className="hint">
            First sign-in on a new deployment? The password you enter becomes your account password
            (at least {MIN_PASSWORD_LENGTH} characters) — type it carefully.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
