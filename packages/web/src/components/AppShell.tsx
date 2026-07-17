import { useState } from 'react';
import { useAuth } from '../auth/auth-context.js';
import { ComposeView } from './ComposeView.js';
import { KeysView } from './KeysView.js';

type Tab = 'compose' | 'keys';

/**
 * The authenticated app. Views are mounted/unmounted on tab switch (not merely
 * hidden), so leaving the API-keys tab unmounts it and drops any revealed secret.
 */
export function AppShell(): React.JSX.Element {
  const { subject, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('compose');

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">FreeMail</span>
        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            className={tab === 'compose' ? 'active' : ''}
            aria-current={tab === 'compose'}
            onClick={() => setTab('compose')}
          >
            Compose
          </button>
          <button
            type="button"
            className={tab === 'keys' ? 'active' : ''}
            aria-current={tab === 'keys'}
            onClick={() => setTab('keys')}
          >
            API keys
          </button>
        </nav>
        <div className="shell-account">
          {subject && <span className="muted">Signed in as {subject}</span>}
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">{tab === 'compose' ? <ComposeView /> : <KeysView />}</main>
    </div>
  );
}
