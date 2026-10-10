import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmailDetail, EmailDirection } from '@freemail/shared';
import { MailOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '../auth/auth-context.js';
import { useMailbox } from '../hooks/use-mailbox.js';
import { getLastSender, useDrafts, type Draft } from '../lib/drafts.js';
import { applyListView, DEFAULT_VIEW, type ListView } from '../lib/mail-filter.js';
import { buildPrefill, type ReplyMode } from '../lib/reply.js';
import { cn } from '@/lib/utils';
import type { ComposeInit } from './ComposeWindow.js';
import { DraftList } from './DraftList.js';
import { EmailReader } from './EmailReader.js';
import { Kbd } from './Kbd.js';
import { KeysView } from './KeysView.js';
import { MessageList } from './MessageList.js';
import { Sidebar, type FolderId } from './Sidebar.js';

export interface AppShellProps {
  /**
   * Whether inbound email is enabled for this deploy. Gates the Inbox and All mail
   * folders — when off, there is no inbox (sent history still shows). Defaults to false
   * so components that mount the shell without config (tests) get the pre-inbound
   * behavior.
   */
  readonly inboundEnabled?: boolean;
}

interface FolderSpec {
  readonly title: string;
  /** undefined → the merged timeline. */
  readonly direction: EmailDirection | undefined;
  readonly emptyMessage: string;
}

// The editor (Tiptap/ProseMirror) is most of the bundle; load it on first compose.
const ComposeWindow = lazy(() =>
  import('./ComposeWindow.js').then((m) => ({ default: m.ComposeWindow })),
);

const MAIL_FOLDERS: Partial<Record<FolderId, FolderSpec>> = {
  inbox: { title: 'Inbox', direction: 'inbound', emptyMessage: 'Your inbox is empty.' },
  sent: { title: 'Sent', direction: 'sent', emptyMessage: 'No sent messages yet.' },
  all: { title: 'All mail', direction: undefined, emptyMessage: 'No messages yet.' },
};

/** Keys typed into a field belong to the field, not to the app's shortcuts. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.closest('[role="dialog"],[role="alertdialog"],[role="menu"]') !== null
  );
}

/**
 * The authenticated app: folders | message list | reading pane, plus a docked compose
 * window. Below `lg` the sidebar becomes a sheet; below `md` the list and the reader
 * share one column and the reader shows with a back button. Views unmount on navigation
 * (not merely hide), so leaving API keys drops any revealed secret.
 */
export function AppShell(props: AppShellProps): React.JSX.Element {
  const auth = useAuth();
  const [folder, setFolder] = useState<FolderId>(props.inboundEnabled ? 'inbox' : 'sent');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openEmail, setOpenEmail] = useState<EmailDetail | null>(null);
  const [view, setView] = useState<ListView>(DEFAULT_VIEW);
  const [navOpen, setNavOpen] = useState(false);
  const [compose, setCompose] = useState<{
    readonly key: number;
    readonly init: ComposeInit;
  } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const drafts = useDrafts();

  const spec = MAIL_FOLDERS[folder];
  const mailbox = useMailbox(spec?.direction, spec !== undefined);
  const visible = useMemo(
    () => (mailbox.state.status === 'ready' ? applyListView(mailbox.state.emails, view) : []),
    [mailbox.state, view],
  );

  const selectFolder = useCallback((next: FolderId) => {
    setFolder(next);
    setSelectedId(null);
    setOpenEmail(null);
    setView(DEFAULT_VIEW);
    setNavOpen(false);
  }, []);

  // Files attached in the open compose window. A replaced window is saved as a draft,
  // and drafts cannot keep files, so replacing one that has attachments is refused.
  const composeAttachments = useRef(0);

  const openCompose = useCallback((init?: Partial<ComposeInit>) => {
    if (composeAttachments.current > 0) {
      toast('Finish your open message first', {
        description: 'It has attachments, which a saved draft can’t keep. Send or close it.',
      });
      return;
    }
    const sender = getLastSender();
    setCompose((prev) => ({
      key: (prev?.key ?? 0) + 1,
      init: { from: sender.address, fromName: sender.name, ...init },
    }));
    setNavOpen(false);
  }, []);

  const onAttachmentCountChange = useCallback((count: number) => {
    composeAttachments.current = count;
  }, []);

  const openDraft = useCallback(
    (draft: Draft) =>
      openCompose({
        draftId: draft.id,
        from: draft.from,
        fromName: draft.fromName,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: draft.html,
      }),
    [openCompose],
  );

  const reply = useCallback(
    (email: EmailDetail, mode: ReplyMode) => {
      const sender = getLastSender();
      openCompose(buildPrefill(email, mode, sender.address));
    },
    [openCompose],
  );

  async function handleRefresh(): Promise<void> {
    try {
      await mailbox.refresh();
    } catch {
      toast.error('Could not refresh. Check your connection and try again.');
    }
  }

  async function handleLoadMore(): Promise<void> {
    try {
      await mailbox.loadMore();
    } catch {
      toast.error('Could not load more messages.');
    }
  }

  // Only a successful server response clears the httpOnly session cookies, so a failed
  // sign-out leaves the session live — surface a retriable error, never a false sign-out.
  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await auth.logout();
    } catch {
      toast.error('Sign-out failed — you are still signed in. Please retry.');
    } finally {
      setSigningOut(false);
    }
  }

  // Keyboard shortcuts. Read through a ref so the listener is bound once.
  const keyState = useRef({ visible, selectedId, openEmail, spec, reply, openCompose });
  keyState.current = { visible, selectedId, openEmail, spec, reply, openCompose };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
      }
      const k = keyState.current;
      const move = (delta: number): void => {
        if (!k.spec || k.visible.length === 0) {
          return;
        }
        const index = k.visible.findIndex((e) => e.id === k.selectedId);
        const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), k.visible.length - 1);
        setSelectedId(k.visible[next].id);
      };
      const handled = (): void => event.preventDefault();
      switch (event.key) {
        case 'c':
          handled();
          k.openCompose();
          break;
        case '/':
          if (k.spec) {
            handled();
            searchRef.current?.focus();
          }
          break;
        case 'j':
        case 'ArrowDown':
          handled();
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          handled();
          move(-1);
          break;
        case 'Escape':
          if (k.selectedId) {
            handled();
            setSelectedId(null);
            setOpenEmail(null);
          }
          break;
        case 'r':
        case 'a':
        case 'f':
          if (k.openEmail) {
            handled();
            k.reply(
              k.openEmail,
              event.key === 'r' ? 'reply' : event.key === 'a' ? 'replyAll' : 'forward',
            );
          }
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const sidebar = (
    <Sidebar
      folder={folder}
      onSelectFolder={selectFolder}
      onCompose={() => openCompose()}
      inboundEnabled={props.inboundEnabled ?? false}
      draftCount={drafts.length}
      subject={auth.subject}
      signingOut={signingOut}
      onSignOut={() => void handleSignOut()}
    />
  );

  const readerOpen = spec !== undefined && selectedId !== null;

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="hidden w-56 shrink-0 border-r lg:block">{sidebar}</aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-64 gap-0 p-0 sm:max-w-64 [&>button]:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Folders and account</SheetDescription>
          {sidebar}
        </SheetContent>
      </Sheet>

      {folder === 'keys' ? (
        <main className="min-w-0 flex-1">
          <KeysView onOpenNav={() => setNavOpen(true)} />
        </main>
      ) : (
        <>
          <div
            className={cn(
              'w-full shrink-0 border-r md:w-[340px] xl:w-[400px]',
              readerOpen && 'max-md:hidden',
            )}
          >
            {folder === 'drafts' ? (
              <DraftList drafts={drafts} onOpen={openDraft} onOpenNav={() => setNavOpen(true)} />
            ) : (
              spec && (
                <MessageList
                  ref={searchRef}
                  title={spec.title}
                  state={mailbox.state}
                  visible={visible}
                  view={view}
                  onViewChange={setView}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  refreshing={mailbox.refreshing}
                  onRefresh={() => void handleRefresh()}
                  loadingMore={mailbox.loadingMore}
                  onLoadMore={() => void handleLoadMore()}
                  emptyMessage={spec.emptyMessage}
                  showSpamFilter={spec.direction !== 'sent'}
                  onOpenNav={() => setNavOpen(true)}
                />
              )
            )}
          </div>
          <main className={cn('min-w-0 flex-1', !readerOpen && 'max-md:hidden')}>
            {readerOpen ? (
              <EmailReader
                id={selectedId}
                onBack={() => {
                  setSelectedId(null);
                  setOpenEmail(null);
                }}
                onReply={reply}
                onLoaded={setOpenEmail}
              />
            ) : (
              <NothingSelected drafts={folder === 'drafts'} />
            )}
          </main>
        </>
      )}

      {compose && (
        <Suspense fallback={null}>
          <ComposeWindow
            key={compose.key}
            init={compose.init}
            onClose={() => {
              composeAttachments.current = 0;
              setCompose(null);
            }}
            onAttachmentCountChange={onAttachmentCountChange}
          />
        </Suspense>
      )}
    </div>
  );
}

function NothingSelected(props: { drafts: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-sidebar/50 px-6 text-center">
      <MailOpen className="size-10 text-muted-foreground/40" strokeWidth={1.25} />
      <p className="mt-3 text-[13px] text-muted-foreground">
        {props.drafts ? 'Select a draft to keep writing.' : 'Select a message to read it.'}
      </p>
      {!props.drafts && (
        <p className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground/90">
          <span className="flex items-center gap-1">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>/</Kbd> search
          </span>
          <span className="flex items-center gap-1">
            <Kbd>C</Kbd> compose
          </span>
          <span className="flex items-center gap-1">
            <Kbd>R</Kbd> reply
          </span>
        </p>
      )}
    </div>
  );
}
