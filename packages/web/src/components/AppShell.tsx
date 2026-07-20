import { useState } from 'react';
import { useAuth } from '../auth/auth-context.js';
import { ComposeView } from './ComposeView.js';
import { KeysView } from './KeysView.js';
import { MailListView } from './MailListView.js';

type Tab = 'inbox' | 'sent' | 'compose' | 'keys';

export interface AppShellProps {
  /**
   * Whether inbound email is enabled for this deploy. Gates the Inbox tab — when off,
   * there is no inbox (sent history still shows). Defaults to false so components that
   * mount the shell without config (tests) get the pre-inbound behavior.
   */
  readonly inboundEnabled?: boolean;
}

/**
 * The authenticated app. Views are mounted/unmounted on tab switch (not merely
 * hidden), so leaving the API-keys tab unmounts it and drops any revealed secret.
 */
export function AppShell({ inboundEnabled = false }: AppShellProps): React.JSX.Element {
  const { subject, logout } = useAuth();
  const [tab, setTab] = useState<Tab>(inboundEnabled ? 'inbox' : 'compose');
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Only a successful server response clears the httpOnly session cookies, so a failed
  // sign-out leaves the session live — surface a retriable error, never a false sign-out.
  const handleSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
    } catch {
      setSignOutError('Sign-out failed — you are still signed in. Please retry.');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">FreeMail</span>
        <nav className="tabs" aria-label="Sections">
          {inboundEnabled && (
            <button
              type="button"
              className={tab === 'inbox' ? 'active' : ''}
              aria-current={tab === 'inbox'}
              onClick={() => setTab('inbox')}
            >
              Inbox
            </button>
          )}
          <button
            type="button"
            className={tab === 'sent' ? 'active' : ''}
            aria-current={tab === 'sent'}
            onClick={() => setTab('sent')}
          >
            Sent
          </button>
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
          <button type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {signOutError && (
            <span role="alert" className="error">
              {signOutError}
            </span>
          )}
        </div>
      </header>
      <main className="shell-main">
        {tab === 'inbox' && (
          <MailListView direction="inbound" title="Inbox" emptyMessage="No messages yet." />
        )}
        {tab === 'sent' && (
          <MailListView direction="sent" title="Sent" emptyMessage="No sent messages yet." />
        )}
        {tab === 'compose' && <ComposeView />}
        {tab === 'keys' && <KeysView />}
      </main>
    </div>
  );
}
