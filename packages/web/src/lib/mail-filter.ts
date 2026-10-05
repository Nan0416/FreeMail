import type { EmailListItem } from '@freemail/shared';

export type SortOrder = 'newest' | 'oldest';
export type QuickFilter = 'all' | 'attachments' | 'spam';

export interface ListView {
  readonly query: string;
  readonly sort: SortOrder;
  readonly filter: QuickFilter;
}

export const DEFAULT_VIEW: ListView = { query: '', sort: 'newest', filter: 'all' };

/**
 * Search, filter and sort the messages ALREADY LOADED. The API has no search endpoint,
 * so this narrows what is on screen; "Load more" widens what it searches.
 */
export function applyListView(emails: readonly EmailListItem[], view: ListView): EmailListItem[] {
  const terms = view.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = emails.filter((email) => {
    if (view.filter === 'attachments' && !email.hasAttachments) {
      return false;
    }
    if (view.filter === 'spam' && !email.quarantined) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const haystack = [
      email.subject,
      email.snippet,
      email.from,
      email.fromName,
      ...email.to,
      ...email.cc,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  // The server returns newest-first; only "oldest" needs a reorder.
  return view.sort === 'oldest' ? matched.reverse() : matched;
}
