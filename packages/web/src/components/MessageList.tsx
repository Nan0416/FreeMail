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
import { failureReason } from '../lib/email-reader.js';
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

export const MessageList = forwardRef<HTMLInputElement, MessageListProps>(
  function MessageList(props, searchRef) {
    const listRef = useRef<HTMLUListElement>(null);
    const filters: readonly QuickFilter[] = props.showSpamFilter
      ? ['all', 'attachments', 'spam']
      : ['all', 'attachments'];
    const total = props.state.status === 'ready' ? props.state.emails.length : 0;
    const narrowed = props.view.query.trim() !== '' || props.view.filter !== 'all';

    // Keep the keyboard-selected row in view.
    useEffect(() => {
      if (!props.selectedId) {
        return;
      }
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(props.selectedId)}"]`,
      );
      row?.scrollIntoView?.({ block: 'nearest' });
    }, [props.selectedId]);

    return (
      <section aria-label={props.title} className="flex h-full min-w-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={props.onOpenNav}
          >
            <Menu />
          </Button>
          <h1 className="text-[15px] font-semibold tracking-tight">{props.title}</h1>
          {props.state.status === 'ready' && (
            <span className="ml-1 text-xs text-muted-foreground tabular-nums">
              {narrowed ? `${props.visible.length} of ${total}` : total}
              {props.state.nextCursor ? '+' : ''}
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
                      className={cn(props.view.filter !== 'all' && 'text-primary')}
                    >
                      <ListFilter />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Filter</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Show
                </DropdownMenuLabel>
                {filters.map((f) => (
                  <DropdownMenuItem
                    key={f}
                    onSelect={() => props.onViewChange({ ...props.view, filter: f })}
                  >
                    <Check className={cn(props.view.filter === f ? 'opacity-100' : 'opacity-0')} />
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
                  <DropdownMenuItem
                    key={s}
                    onSelect={() => props.onViewChange({ ...props.view, sort: s })}
                  >
                    <Check className={cn(props.view.sort === s ? 'opacity-100' : 'opacity-0')} />
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
                  disabled={props.refreshing || props.state.status === 'loading'}
                  onClick={props.onRefresh}
                >
                  <RotateCw className={cn(props.refreshing && 'animate-spin')} />
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
              value={props.view.query}
              onChange={(e) => props.onViewChange({ ...props.view, query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  props.onViewChange({ ...props.view, query: '' });
                  e.currentTarget.blur();
                }
              }}
              className="h-8 w-full rounded-md border border-transparent bg-muted pr-8 pl-8 text-[13px] transition-colors outline-none placeholder:text-muted-foreground focus:border-input focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
            />
            {props.view.query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => props.onViewChange({ ...props.view, query: '' })}
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
          {props.state.status === 'loading' && <ListSkeleton />}
          {props.state.status === 'error' && (
            <div className="p-6 text-center">
              <p role="alert" className="text-[13px] text-destructive">
                {props.state.message}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={props.onRefresh}>
                Try again
              </Button>
            </div>
          )}
          {props.state.status === 'ready' && props.visible.length === 0 && (
            <EmptyState
              icon={narrowed ? SearchX : Inbox}
              message={narrowed ? 'No loaded messages match.' : props.emptyMessage}
              hint={
                narrowed && props.state.nextCursor ? 'Load more to search further back.' : undefined
              }
            />
          )}
          {props.state.status === 'ready' && props.visible.length > 0 && (
            <ul ref={listRef} aria-label={props.title} className="divide-y divide-border/70">
              {props.visible.map((email) => (
                <MessageRow
                  key={email.id}
                  email={email}
                  selected={email.id === props.selectedId}
                  onSelect={props.onSelect}
                />
              ))}
            </ul>
          )}
          {props.state.status === 'ready' && props.state.nextCursor && (
            <div className="border-t p-3">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                disabled={props.loadingMore}
                onClick={props.onLoadMore}
              >
                {props.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  },
);

function MessageRow(props: {
  email: EmailListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const party =
    props.email.direction === 'inbound'
      ? props.email.fromName || props.email.from
      : `To: ${props.email.to.map(shortAddress).join(', ') || '—'}`;
  return (
    <li data-id={props.email.id}>
      <button
        type="button"
        aria-current={props.selected ? 'true' : undefined}
        onClick={() => props.onSelect(props.email.id)}
        className={cn(
          'relative block w-full px-4 py-2.5 text-left transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          props.selected ? 'bg-selected' : 'hover:bg-accent/70',
        )}
      >
        {props.selected && (
          <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
        )}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{party}</span>
          {props.email.hasAttachments && (
            <Paperclip
              aria-label="Has attachments"
              className="size-3.5 shrink-0 self-center text-muted-foreground"
            />
          )}
          <time
            dateTime={props.email.date}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {formatListDate(props.email.date)}
          </time>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="text-foreground/90">{props.email.subject || '(no subject)'}</span>
            {props.email.snippet && (
              <span className="text-muted-foreground"> — {props.email.snippet}</span>
            )}
          </span>
          <QuarantineTag email={props.email} />
          {props.email.status === 'send_failed' && <RowTag tone="destructive">Failed</RowTag>}
          {props.email.status === 'sending' && <RowTag tone="muted">Sending</RowTag>}
        </span>
      </button>
    </li>
  );
}

/**
 * Why a quarantined row is hidden: the failure (virus / parse) when its content was withheld,
 * otherwise spam. A virus verdict other than PASS is shown as destructive.
 */
function QuarantineTag(props: { email: EmailListItem }): React.JSX.Element | null {
  if (props.email.direction !== 'inbound' || !props.email.quarantined) {
    return null;
  }
  const reason = failureReason(props.email);
  if (reason) {
    return <RowTag tone={reason.suspicious ? 'destructive' : 'warning'}>{reason.label}</RowTag>;
  }
  return <RowTag tone="warning">Spam</RowTag>;
}

function RowTag(props: {
  tone: 'warning' | 'destructive' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
        props.tone === 'warning' && 'bg-warning-surface text-warning',
        props.tone === 'destructive' && 'bg-destructive/10 text-destructive',
        props.tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
    >
      {props.children}
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

function EmptyState(props: {
  icon: typeof Inbox;
  message: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <props.icon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
      <p className="mt-3 text-[13px] text-muted-foreground">{props.message}</p>
      {props.hint && <p className="mt-1 text-xs text-muted-foreground/80">{props.hint}</p>}
    </div>
  );
}
