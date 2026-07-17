import { useState } from 'react';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';

type Mode = 'login' | 'set-password';

/**
 * The unauthenticated gate. It starts in login mode; if the server reports the
 * password has not been set yet (`password_not_set`), it flips to first-run
 * set-password mode. There is no unauthenticated "is a password set?" probe, so
 * the login attempt is what discovers first-run.
 */
export function SignInView(): React.JSX.Element {
  const { login, setPasswordAndLogin } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(password);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'password_not_set') {
        setMode('set-password');
        setError(null);
      } else {
        setError(err instanceof ApiError ? err.message : 'Sign in failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSetPassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (passwordPolicyError(password) !== null) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await setPasswordAndLogin(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <div className="card auth-card">
        <h1>FreeMail</h1>
        {mode === 'login' ? (
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
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || password.length === 0}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={onSetPassword} aria-label="Set password">
            <p className="muted">
              Welcome — this deployment has no password yet. Set one to secure your FreeMail.
            </p>
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <label htmlFor="confirm-password">Confirm password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            <p className="hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || password.length === 0}>
              {busy ? 'Setting password…' : 'Set password & sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
