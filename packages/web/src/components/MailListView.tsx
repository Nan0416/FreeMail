import { useEffect, useState } from 'react';
import type { EmailDirection, EmailListItem } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { formatDate } from '../lib/format.js';
import { EmailReader } from './EmailReader.js';

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly emails: readonly EmailListItem[];
      readonly nextCursor?: string;
    };

export interface MailListViewProps {
  /** Which partition to list — `inbound` for the Inbox, `sent` for Sent. */
  readonly direction: EmailDirection;
  readonly title: string;
  /** Shown when the list is empty. */
  readonly emptyMessage: string;
}

export function MailListView({
  direction,
  title,
  emptyMessage,
}: MailListViewProps): React.JSX.Element {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    setSelectedId(null);
    client
      .listEmails({ direction })
      .then((res) => {
        if (active) {
          setState({ status: 'ready', emails: res.emails, nextCursor: res.nextCursor });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: err instanceof ApiError ? err.message : 'Could not load messages.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [client, direction]);

  async function loadMore(): Promise<void> {
    if (state.status !== 'ready' || !state.nextCursor) {
      return;
    }
    setLoadingMore(true);
    try {
      const res = await client.listEmails({ direction, cursor: state.nextCursor });
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', emails: [...prev.emails, ...res.emails], nextCursor: res.nextCursor }
          : prev,
      );
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof ApiError ? err.message : 'Could not load more messages.',
      });
    } finally {
      setLoadingMore(false);
    }
  }

  if (selectedId) {
    return <EmailReader id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <section className="card">
      <h2>{title}</h2>
      {state.status === 'loading' && <p className="muted">Loading…</p>}
      {state.status === 'error' && (
        <p role="alert" className="error">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && state.emails.length === 0 && (
        <p className="muted">{emptyMessage}</p>
      )}
      {state.status === 'ready' && state.emails.length > 0 && (
        <ul className="mail-list" aria-label={title}>
          {state.emails.map((email) => (
            <li key={email.id}>
              <button type="button" className="mail-row" onClick={() => setSelectedId(email.id)}>
                <span className="mail-row-top">
                  <span className="mail-party">
                    {direction === 'inbound'
                      ? email.fromName || email.from
                      : `To: ${email.to.join(', ') || '—'}`}
                  </span>
                  <span className="mail-date hint">{formatDate(email.date)}</span>
                </span>
                <span className="mail-subject">{email.subject || '(no subject)'}</span>
                {email.snippet && <span className="mail-snippet hint">{email.snippet}</span>}
                <span className="mail-badges">
                  {email.hasAttachments && (
                    <span className="badge" aria-label="Has attachments" title="Has attachments">
                      📎
                    </span>
                  )}
                  {email.quarantined && <span className="badge badge-warn">Quarantined</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === 'ready' && state.nextCursor && (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
