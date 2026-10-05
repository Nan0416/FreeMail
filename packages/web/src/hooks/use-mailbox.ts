import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmailDirection, EmailListItem } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';

export type MailboxState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly emails: readonly EmailListItem[];
      readonly nextCursor?: string;
    };

export interface Mailbox {
  readonly state: MailboxState;
  /** A background refresh is in flight (the current list stays on screen). */
  readonly refreshing: boolean;
  readonly loadingMore: boolean;
  readonly refresh: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
}

/**
 * One folder's message list. `direction` undefined is the merged timeline (All mail).
 * A refresh keeps the current rows visible and swaps them in place, so the list never
 * flashes back to a skeleton once it has loaded.
 */
export function useMailbox(direction: EmailDirection | undefined, enabled = true): Mailbox {
  const { client } = useAuth();
  const [state, setState] = useState<MailboxState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Drops responses for a folder we have since navigated away from.
  const generation = useRef(0);

  const fetchFirstPage = useCallback(
    async (background: boolean) => {
      const gen = ++generation.current;
      if (background) {
        setRefreshing(true);
      } else {
        setState({ status: 'loading' });
      }
      try {
        const res = await client.listEmails(direction ? { direction } : {});
        if (gen === generation.current) {
          setState({ status: 'ready', emails: res.emails, nextCursor: res.nextCursor });
        }
      } catch (err) {
        if (gen === generation.current) {
          setState({
            status: 'error',
            message: err instanceof ApiError ? err.message : 'Could not load messages.',
          });
        }
        if (background) {
          throw err;
        }
      } finally {
        if (gen === generation.current) {
          setRefreshing(false);
        }
      }
    },
    [client, direction],
  );

  useEffect(() => {
    if (enabled) {
      void fetchFirstPage(false);
    }
    return () => {
      generation.current += 1;
    };
  }, [fetchFirstPage, enabled]);

  const refresh = useCallback(() => fetchFirstPage(true), [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    if (state.status !== 'ready' || !state.nextCursor || loadingMore) {
      return;
    }
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const res = await client.listEmails({
        ...(direction ? { direction } : {}),
        cursor: state.nextCursor,
      });
      if (gen === generation.current) {
        setState((prev) =>
          prev.status === 'ready'
            ? {
                status: 'ready',
                emails: [...prev.emails, ...res.emails],
                nextCursor: res.nextCursor,
              }
            : prev,
        );
      }
    } finally {
      setLoadingMore(false);
    }
  }, [client, direction, state, loadingMore]);

  return { state, refreshing, loadingMore, refresh, loadMore };
}
