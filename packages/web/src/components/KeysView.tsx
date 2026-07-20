import { useCallback, useEffect, useState } from 'react';
import { MAX_API_KEY_NAME_LENGTH, type ApiKeySummary } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { KeyRevealPanel } from './KeyRevealPanel.js';

export function KeysView(): React.JSX.Element {
  const { client } = useAuth();
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // The raw secret, held ONLY here, transiently, and shown exactly once. Never
  // persisted, never logged, never stored in the `keys` list.
  const [revealed, setRevealed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await client.listKeys();
      setKeys(response.keys);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load API keys.');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Belt-and-suspenders: drop the secret from state on unmount (tab switch / logout
  // both unmount this view), so it cannot outlive the moment it was shown.
  useEffect(() => () => setRevealed(null), []);

  async function onCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await client.createKey(name.trim() || undefined);
      // Keep ONLY the raw string; put just the summary fields into the list.
      setRevealed(created.key);
      setKeys((prev) => [
        { id: created.id, name: created.name, createdAt: created.createdAt },
        ...prev,
      ]);
      setName('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the API key.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    setError(null);
    setConfirmingId(null);
    try {
      await client.revokeKey(id);
      setKeys((prev) => prev.filter((key) => key.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the API key.');
    }
  }

  return (
    <section className="card">
      <h2>API keys</h2>
      <p className="muted">
        API keys let your agents send email through the MCP server. One key grants full access; it
        is shown once, at creation.
      </p>

      {revealed && <KeyRevealPanel apiKey={revealed} onDismiss={() => setRevealed(null)} />}

      <form onSubmit={onCreate} aria-label="Create API key" className="inline-form">
        <label htmlFor="key-name">Name (optional)</label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_API_KEY_NAME_LENGTH}
          placeholder="e.g. my-agent"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {keys.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <ul className="key-list" aria-label="API keys">
          {keys.map((key) => (
            <li key={key.id}>
              <div>
                <span className="key-name">{key.name ?? 'Unnamed key'}</span>
                <span className="muted key-id">{key.id}</span>
                <span className="muted">{new Date(key.createdAt).toLocaleString()}</span>
              </div>
              {confirmingId === key.id ? (
                <div className="confirm-row">
                  <span>Revoke this key?</span>
                  <button type="button" className="danger" onClick={() => void onRevoke(key.id)}>
                    Confirm
                  </button>
                  <button type="button" onClick={() => setConfirmingId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmingId(key.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
