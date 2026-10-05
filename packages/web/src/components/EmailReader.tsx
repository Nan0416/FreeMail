import { useEffect, useState } from 'react';
import type { EmailAttachmentInfo, EmailDetail } from '@freemail/shared';
import {
  ArrowLeft,
  Copy,
  Download,
  Forward,
  ImageOff,
  Image as ImageIcon,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { bodyKind, quarantineNotice } from '../lib/email-reader.js';
import { formatBytes, formatLongDate } from '../lib/format.js';
import { avatarTint, initials } from '../lib/people.js';
import type { ReplyMode } from '../lib/reply.js';
import { cn } from '@/lib/utils';
import { EmailBodyFrame } from './EmailBodyFrame.js';
import { Kbd } from './Kbd.js';

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly email: EmailDetail };

export interface EmailReaderProps {
  /** Opaque message handle from the list. */
  readonly id: string;
  /** Return to the list (narrow layouts, where the reader replaces it). */
  readonly onBack: () => void;
  /** Open a compose window prefilled from this message. */
  readonly onReply?: (email: EmailDetail, mode: ReplyMode) => void;
  /** Reports the loaded message upward, so keyboard shortcuts can reply to it. */
  readonly onLoaded?: (email: EmailDetail | null) => void;
}

export function EmailReader({
  id,
  onBack,
  onReply,
  onLoaded,
}: EmailReaderProps): React.JSX.Element {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: 'loading' });
  // Remote images blocked by default (tracking pixels); revealed per message.
  const [showImages, setShowImages] = useState(false);
  // Quarantined (spam) bodies stay hidden until the reader opts in.
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    setShowImages(false);
    setRevealed(false);
    onLoaded?.(null);
    client
      .getEmail(id)
      .then((email) => {
        if (active) {
          setState({ status: 'ready', email });
          onLoaded?.(email);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: err instanceof ApiError ? err.message : 'Could not load this message.',
          });
        }
      });
    return () => {
      active = false;
    };
    // `onLoaded` is deliberately not a dependency: it is a notification sink, and
    // re-fetching whenever its identity changes would refetch on every parent render.
  }, [client, id]);

  async function download(attachment: EmailAttachmentInfo): Promise<void> {
    try {
      const { url } = await client.getAttachmentUrl(id, attachment.id);
      // The presigned URL forces `Content-Disposition: attachment` + octet-stream, so a
      // plain anchor click downloads it (never renders inline) and the SPA stays put.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the attachment.');
    }
  }

  const email = state.status === 'ready' ? state.email : null;

  return (
    <article aria-label="Message" className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Back to list"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <ToolbarButton
          label="Reply"
          shortcut="R"
          disabled={!email}
          onClick={() => email && onReply?.(email, 'reply')}
        >
          <Reply />
        </ToolbarButton>
        <ToolbarButton
          label="Reply all"
          shortcut="A"
          disabled={!email}
          onClick={() => email && onReply?.(email, 'replyAll')}
        >
          <ReplyAll />
        </ToolbarButton>
        <ToolbarButton
          label="Forward"
          shortcut="F"
          disabled={!email}
          onClick={() => email && onReply?.(email, 'forward')}
        >
          <Forward />
        </ToolbarButton>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions" disabled={!email}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {email && bodyKind(email) === 'html' && email.direction === 'inbound' && (
                <DropdownMenuItem onSelect={() => setShowImages((v) => !v)}>
                  {showImages ? <ImageOff /> : <ImageIcon />}
                  {showImages ? 'Block remote images' : 'Load remote images'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  if (email) {
                    void copy(email.from, 'Sender address copied');
                  }
                }}
              >
                <Copy />
                Copy sender address
              </DropdownMenuItem>
              {email && email.attachments.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {email.attachments.map((a) => (
                    <DropdownMenuItem key={a.id} onSelect={() => void download(a)}>
                      <Download />
                      <span className="truncate">{a.filename}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {state.status === 'loading' && <ReaderSkeleton />}
      {state.status === 'error' && (
        <div className="p-8">
          <p role="alert" className="text-[13px] text-destructive">
            {state.message}
          </p>
        </div>
      )}
      {email && (
        <ReaderContent
          email={email}
          showImages={showImages}
          onShowImages={() => setShowImages(true)}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onDownload={(a) => void download(a)}
        />
      )}
    </article>
  );
}

async function copy(value: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error('Clipboard access was denied.');
  }
}

function ToolbarButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        <Kbd className="border-white/20 bg-white/10 text-background/80">{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function ReaderContent({
  email,
  showImages,
  onShowImages,
  revealed,
  onReveal,
  onDownload,
}: {
  email: EmailDetail;
  showImages: boolean;
  onShowImages: () => void;
  revealed: boolean;
  onReveal: () => void;
  onDownload: (attachment: EmailAttachmentInfo) => void;
}): React.JSX.Element {
  const notice = quarantineNotice(email);
  const showBody = !notice || revealed;
  const kind = bodyKind(email);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 md:px-8 pt-6 pb-4">
        <h2 className="text-xl leading-snug font-semibold tracking-tight text-balance">
          {email.subject || '(no subject)'}
        </h2>

        <div className="mt-5 flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-medium',
              avatarTint(email.from),
            )}
          >
            {initials(email.fromName, email.from)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{email.fromName || email.from}</span>
              {email.fromName && (
                <span className="truncate text-[13px] text-muted-foreground">
                  &lt;{email.from}&gt;
                </span>
              )}
            </div>
            <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-1.5 text-[13px] text-muted-foreground">
              <dt>To</dt>
              <dd className="min-w-0 truncate">{email.to.length ? email.to.join(', ') : '—'}</dd>
              {email.cc.length > 0 && (
                <>
                  <dt>Cc</dt>
                  <dd className="min-w-0 truncate">{email.cc.join(', ')}</dd>
                </>
              )}
              {email.bcc && email.bcc.length > 0 && (
                <>
                  <dt>Bcc</dt>
                  <dd className="min-w-0 truncate">{email.bcc.join(', ')}</dd>
                </>
              )}
            </dl>
          </div>
          <time
            dateTime={email.date}
            className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
          >
            {formatLongDate(email.date)}
          </time>
        </div>

        {email.attachments.length > 0 && (
          <ul aria-label="Attachments" className="mt-5 flex flex-wrap gap-2">
            {email.attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  onClick={() => onDownload(attachment)}
                  aria-label={`Download ${attachment.filename}`}
                  className="group flex max-w-64 items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {attachment.filename}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatBytes(attachment.sizeBytes)}
                    </span>
                  </span>
                  <Download className="ml-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {notice && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-3 rounded-md border border-warning/25 bg-warning-surface px-3 py-2.5 text-[13px]"
          >
            <ShieldAlert className="mt-px size-4 shrink-0 text-warning" />
            <p className="flex-1">{notice.message}</p>
            {notice.canReveal && !revealed && (
              <Button variant="outline" size="xs" onClick={onReveal}>
                Show message
              </Button>
            )}
          </div>
        )}

        {showBody && kind === 'html' && !showImages && email.direction === 'inbound' && (
          <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
            <ImageOff className="size-3.5" />
            Remote images are blocked.
            <button
              type="button"
              onClick={onShowImages}
              className="font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
            >
              Show images
            </button>
          </div>
        )}
      </div>

      {email.direction === 'sent' ? (
        <p className="mx-auto w-full max-w-3xl px-5 md:px-8 pb-10 text-[13px] text-muted-foreground">
          The body of a sent message isn&rsquo;t stored — only its metadata.
        </p>
      ) : (
        showBody && (
          <>
            {kind === 'html' && email.html !== undefined && (
              <EmailBodyFrame html={email.html} allowImages={showImages} />
            )}
            {kind === 'text' && (
              <pre className="mx-auto w-full max-w-3xl px-5 md:px-8 pb-10 font-sans text-sm leading-relaxed whitespace-pre-wrap">
                {email.text}
              </pre>
            )}
            {kind === 'none' && (
              <p className="mx-auto w-full max-w-3xl px-5 md:px-8 pb-10 text-[13px] text-muted-foreground">
                This message has no readable body.
              </p>
            )}
            {email.bodyTruncated && (
              <p className="mx-auto w-full max-w-3xl px-5 md:px-8 pb-6 text-xs text-muted-foreground">
                This message was truncated for display.
              </p>
            )}
          </>
        )
      )}
    </div>
  );
}

function ReaderSkeleton(): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading message"
      className="mx-auto w-full max-w-3xl px-5 md:px-8 pt-6"
    >
      <Skeleton className="h-6 w-2/3" />
      <div className="mt-6 flex gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      <div className="mt-8 space-y-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
