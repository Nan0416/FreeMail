import { forwardRef, useEffect, useRef } from 'react';
import type { EmailListItem } from '@freemail/shared';
import {
  ArrowDownUp,
  Check,
  Inbox,
  ListFilter,
  Menu,
  Paperclip,
  RotateCw,
  Search,
  SearchX,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MailboxState } from '../hooks/use-mailbox.js';
import { formatListDate } from '../lib/format.js';
import type { ListView, QuickFilter, SortOrder } from '../lib/mail-filter.js';
import { shortAddress } from '../lib/people.js';
import { cn } from '@/lib/utils';
import { Kbd } from './Kbd.js';

export interface MessageListProps {
  readonly title: string;
  readonly state: MailboxState;
  /** The loaded messages after search / filter / sort. */
  readonly visible: readonly EmailListItem[];
  readonly view: ListView;
  readonly onViewChange: (view: ListView) => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly emptyMessage: string;
  /** Whether the spam quick-filter applies (inbound folders only). */
  readonly showSpamFilter: boolean;
  /** Shown below `lg`, where the sidebar collapses into a sheet. */
  readonly onOpenNav: () => void;
}

const SORT_LABELS: Record<SortOrder, string> = { newest: 'Newest first', oldest: 'Oldest first' };
const FILTER_LABELS: Record<QuickFilter, string> = {
  all: 'All messages',
  attachments: 'Has attachments',
  spam: 'Flagged as spam',
};

export const MessageList = forwardRef<HTMLInputElement, MessageListProps>(function MessageList(
  {
    title,
    state,
    visible,
    view,
    onViewChange,
    selectedId,
    onSelect,
    refreshing,
    onRefresh,
    loadingMore,
    onLoadMore,
    emptyMessage,
    showSpamFilter,
    onOpenNav,
  },
  searchRef,
) {
  const listRef = useRef<HTMLUListElement>(null);
  const filters: readonly QuickFilter[] = showSpamFilter
    ? ['all', 'attachments', 'spam']
    : ['all', 'attachments'];
  const total = state.status === 'ready' ? state.emails.length : 0;
  const narrowed = view.query.trim() !== '' || view.filter !== 'all';

  // Keep the keyboard-selected row in view.
  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-id="${CSS.escape(selectedId)}"]`,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  return (
    <section aria-label={title} className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="Open navigation"
          onClick={onOpenNav}
        >
          <Menu />
        </Button>
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {state.status === 'ready' && (
          <span className="ml-1 text-xs text-muted-foreground tabular-nums">
            {narrowed ? `${visible.length} of ${total}` : total}
            {state.nextCursor ? '+' : ''}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Filter"
                    className={cn(view.filter !== 'all' && 'text-primary')}
                  >
                    <ListFilter />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Filter</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Show</DropdownMenuLabel>
              {filters.map((f) => (
                <DropdownMenuItem key={f} onSelect={() => onViewChange({ ...view, filter: f })}>
                  <Check className={cn(view.filter === f ? 'opacity-100' : 'opacity-0')} />
                  {FILTER_LABELS[f]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Sort">
                    <ArrowDownUp />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Sort</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-44">
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onViewChange({ ...view, sort: s })}>
                  <Check className={cn(view.sort === s ? 'opacity-100' : 'opacity-0')} />
                  {SORT_LABELS[s]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={refreshing || state.status === 'loading'}
                onClick={onRefresh}
              >
                <RotateCw className={cn(refreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search messages"
            placeholder="Search loaded messages"
            value={view.query}
            onChange={(e) => onViewChange({ ...view, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onViewChange({ ...view, query: '' });
                e.currentTarget.blur();
              }
            }}
            className="h-8 w-full rounded-md border border-transparent bg-muted pr-8 pl-8 text-[13px] transition-colors outline-none placeholder:text-muted-foreground focus:border-input focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {view.query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onViewChange({ ...view, query: '' })}
              className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === 'loading' && <ListSkeleton />}
        {state.status === 'error' && (
          <div className="p-6 text-center">
            <p role="alert" className="text-[13px] text-destructive">
              {state.message}
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        )}
        {state.status === 'ready' && visible.length === 0 && (
          <EmptyState
            icon={narrowed ? SearchX : Inbox}
            message={narrowed ? 'No loaded messages match.' : emptyMessage}
            hint={narrowed && state.nextCursor ? 'Load more to search further back.' : undefined}
          />
        )}
        {state.status === 'ready' && visible.length > 0 && (
          <ul ref={listRef} aria-label={title} className="divide-y divide-border/70">
            {visible.map((email) => (
              <MessageRow
                key={email.id}
                email={email}
                selected={email.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
        {state.status === 'ready' && state.nextCursor && (
          <div className="border-t p-3">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
});

function MessageRow({
  email,
  selected,
  onSelect,
}: {
  email: EmailListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const party =
    email.direction === 'inbound'
      ? email.fromName || email.from
      : `To: ${email.to.map(shortAddress).join(', ') || '—'}`;
  return (
    <li data-id={email.id}>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(email.id)}
        className={cn(
          'relative block w-full px-4 py-2.5 text-left transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          selected ? 'bg-selected' : 'hover:bg-accent/70',
        )}
      >
        {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{party}</span>
          {email.hasAttachments && (
            <Paperclip
              aria-label="Has attachments"
              className="size-3.5 shrink-0 self-center text-muted-foreground"
            />
          )}
          <time
            dateTime={email.date}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {formatListDate(email.date)}
          </time>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="text-foreground/90">{email.subject || '(no subject)'}</span>
            {email.snippet && <span className="text-muted-foreground"> — {email.snippet}</span>}
          </span>
          {email.quarantined && <RowTag tone="warning">Spam</RowTag>}
          {email.status === 'send_failed' && <RowTag tone="destructive">Failed</RowTag>}
          {email.status === 'sending' && <RowTag tone="muted">Sending</RowTag>}
        </span>
      </button>
    </li>
  );
}

function RowTag({
  tone,
  children,
}: {
  tone: 'warning' | 'destructive' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
        tone === 'warning' && 'bg-warning-surface text-warning',
        tone === 'destructive' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading messages" className="divide-y divide-border/70">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="space-y-2 px-4 py-3">
          <div className="flex justify-between gap-6">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton
            className={cn('h-3', i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-5/6' : 'w-2/3')}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  message,
  hint,
}: {
  icon: typeof Inbox;
  message: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <Icon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
      <p className="mt-3 text-[13px] text-muted-foreground">{message}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
