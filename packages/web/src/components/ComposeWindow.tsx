import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import {
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  type EmailAttachmentRef,
  type SendEmailRequest,
} from '@freemail/shared';
import { Maximize2, Minimize2, Minus, Paperclip, Trash2, Type, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { deleteDraft, newDraftId, saveDraft, setLastSender, type Draft } from '../lib/drafts.js';
import { formatBytes } from '../lib/format.js';
import { parseRecipients } from '../lib/people.js';
import { cn } from '@/lib/utils';
import { FormattingToolbar, RichTextBody } from './RichTextEditor.js';

/** What a compose window opens with: blank, a reply/forward prefill, or a saved draft. */
export interface ComposeInit {
  /** Present when resuming a saved draft; otherwise a new draft id is minted. */
  readonly draftId?: string;
  readonly from: string;
  readonly fromName?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly subject?: string;
  readonly html?: string;
}

export interface ComposeWindowProps {
  readonly init: ComposeInit;
  readonly onClose: () => void;
  /** Reports how many files are attached, which a saved draft cannot keep. */
  readonly onAttachmentCountChange?: (count: number) => void;
}

type WindowMode = 'normal' | 'minimized' | 'maximized';

const AUTOSAVE_MS = 800;

/**
 * Reuse a finished upload for this long when Send is pressed again (a rejected recipient, say).
 * The server sweeps an unsent upload after a day at the earliest.
 */
const UPLOAD_REUSE_MS = 12 * 60 * 60 * 1000;

/** A file already uploaded from this window: its upload id, and when it was uploaded. */
interface FinishedUpload {
  readonly uploadId: string;
  readonly uploadedAt: number;
}

/**
 * A docked compose window: bottom-right on desktop, full-screen on phones, and a large
 * centred sheet when maximized. Edits auto-save to a browser-local draft (see
 * `lib/drafts.ts`); closing keeps the draft, discarding deletes it (with undo).
 */
export function ComposeWindow(props: ComposeWindowProps): React.JSX.Element {
  const auth = useAuth();
  const draftId = useRef(props.init.draftId ?? newDraftId());
  const [from, setFrom] = useState(props.init.from);
  const [fromName, setFromName] = useState(props.init.fromName ?? '');
  const [to, setTo] = useState(props.init.to ?? '');
  const [cc, setCc] = useState(props.init.cc ?? '');
  const [bcc, setBcc] = useState(props.init.bcc ?? '');
  const [showCcBcc, setShowCcBcc] = useState(Boolean(props.init.cc || props.init.bcc));
  const [subject, setSubject] = useState(props.init.subject ?? '');
  const [html, setHtml] = useState(props.init.html ?? '');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<WindowMode>('normal');
  const [showToolbar, setShowToolbar] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** While attachments upload: "Uploading 2 of 3…" on the send button. */
  const [progress, setProgress] = useState<string | null>(null);
  // The re-entrancy guard. `busy` drives the UI but only lands on the next render, so
  // a second ⌘↵ in the same tick would still see it false and send twice.
  const sending = useRef(false);
  /** Files already uploaded from this window, so a retried send doesn't upload them again. */
  const uploaded = useRef(new WeakMap<File, FinishedUpload>());
  const [savedAt, setSavedAt] = useState<Date | null>(props.init.draftId ? new Date() : null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  // Set once sent or discarded, so the unmount-save does not resurrect the draft.
  const finished = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: 'Write your message…' }),
    ],
    content: props.init.html ?? '',
    onCreate: (event) => setText(event.editor.getText()),
    onUpdate: (event) => {
      setHtml(event.editor.getHTML());
      setText(event.editor.getText());
    },
  });

  const hasContent =
    [to, cc, bcc, subject].some((v) => v.trim() !== '') || text.trim() !== '' || files.length > 0;

  const snapshot = (): Draft => ({
    id: draftId.current,
    from,
    ...(fromName.trim() ? { fromName } : {}),
    to,
    cc,
    bcc,
    subject,
    html,
    updatedAt: new Date().toISOString(),
  });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const contentRef = useRef(hasContent);
  contentRef.current = hasContent;

  // Debounced auto-save while there is something worth keeping.
  useEffect(() => {
    if (!hasContent || finished.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      saveDraft(latest.current());
      setSavedAt(new Date());
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [from, fromName, to, cc, bcc, subject, html, hasContent]);

  useEffect(() => {
    props.onAttachmentCountChange?.(files.length);
  }, [files.length, props.onAttachmentCountChange]);

  // Flush on unmount (window closed, or replaced by another compose).
  useEffect(
    () => () => {
      if (!finished.current && contentRef.current) {
        saveDraft(latest.current());
      }
    },
    [],
  );

  // Focus the first field that needs input, once the editor exists. `init` is fixed for
  // the life of the window, so this runs on open only.
  useEffect(() => {
    if (!props.init.to) {
      toInput.current?.focus();
    } else {
      editor?.commands.focus('start');
    }
  }, [editor, props.init.to]);

  function close(): void {
    if (hasContent) {
      saveDraft(snapshot());
      toast('Draft saved', { description: 'Find it in Drafts.' });
    }
    finished.current = true;
    props.onClose();
  }

  function discard(): void {
    const kept = snapshot();
    finished.current = true;
    deleteDraft(draftId.current);
    props.onClose();
    if (hasContent) {
      toast('Draft discarded', {
        action: { label: 'Undo', onClick: () => saveDraft(kept) },
      });
    }
  }

  async function send(): Promise<void> {
    if (sending.current) {
      return;
    }
    setError(null);
    const recipients = {
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
    };
    if (from.trim() === '') {
      setError('Add the address to send from.');
      return;
    }
    if (recipients.to.length + recipients.cc.length + recipients.bcc.length === 0) {
      setError('Add at least one recipient.');
      return;
    }
    // Read the body from the editor itself: the mirrored `text` state lags one tick
    // behind it (the editor reports its initial content asynchronously).
    const bodyHtml = editor?.getHTML() ?? html;
    const bodyText = editor?.getText({ blockSeparator: '\n\n' }) ?? text;
    if (bodyText.trim().length === 0) {
      setError('The message is empty.');
      return;
    }
    if (files.length > MAX_ATTACHMENTS) {
      setError(`At most ${MAX_ATTACHMENTS} attachments are allowed.`);
      return;
    }
    const empty = files.find((file) => file.size === 0);
    if (empty) {
      setError(`"${empty.name}" is empty — remove it or attach another file.`);
      return;
    }
    const tooLarge = files.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooLarge) {
      setError(
        `"${tooLarge.name}" is ${formatBytes(tooLarge.size)} — the limit is ` +
          `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB per attachment.`,
      );
      return;
    }

    sending.current = true;
    setBusy(true);
    try {
      // Each file goes straight to S3 (a presigned PUT); the send references it by upload id.
      const attachments: EmailAttachmentRef[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const previous = uploaded.current.get(file);
        if (previous && Date.now() - previous.uploadedAt < UPLOAD_REUSE_MS) {
          attachments.push({ uploadId: previous.uploadId });
          continue;
        }
        setProgress(`Uploading ${index + 1} of ${files.length}…`);
        const upload = await auth.client.createUpload({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        });
        await auth.client.putUpload(upload.uploadUrl, file);
        uploaded.current.set(file, { uploadId: upload.uploadId, uploadedAt: Date.now() });
        attachments.push({ uploadId: upload.uploadId });
      }
      setProgress(null);
      const request: SendEmailRequest = {
        from: from.trim(),
        ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
        ...(recipients.to.length ? { to: recipients.to } : {}),
        ...(recipients.cc.length ? { cc: recipients.cc } : {}),
        ...(recipients.bcc.length ? { bcc: recipients.bcc } : {}),
        ...(subject.trim() ? { subject } : {}),
        // Both parts: HTML for capable clients, plain text as the alternative.
        html: bodyHtml,
        text: bodyText,
        ...(attachments.length ? { attachments } : {}),
      };
      await auth.client.sendEmail(request);
      setLastSender({ address: request.from, name: fromName.trim() });
      finished.current = true;
      deleteDraft(draftId.current);
      toast.success('Message sent');
      props.onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send the message.');
    } finally {
      sending.current = false;
      setBusy(false);
      setProgress(null);
    }
  }

  const title = subject.trim() || 'New message';

  if (mode === 'minimized') {
    return (
      <div className="fixed right-4 bottom-0 z-40 w-72 max-md:right-0 max-md:w-full">
        <div className="flex h-10 items-center gap-1 rounded-t-lg border border-b-0 bg-foreground pr-1 pl-3 text-background shadow-lg">
          <button
            type="button"
            onClick={() => setMode('normal')}
            className="min-w-0 flex-1 truncate text-left text-[13px] font-medium focus-visible:underline focus-visible:outline-none"
          >
            {title}
          </button>
          <WindowButton label="Restore" onClick={() => setMode('normal')} dark>
            <Maximize2 />
          </WindowButton>
          <WindowButton label="Close" onClick={close} dark>
            <X />
          </WindowButton>
        </div>
      </div>
    );
  }

  const maximized = mode === 'maximized';

  return (
    <>
      {maximized && (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-foreground/20 animate-in fade-in-0"
          onClick={() => setMode('normal')}
        />
      )}
      <section
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            setMode(maximized ? 'normal' : 'minimized');
          }
        }}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden border bg-background shadow-2xl shadow-black/10 animate-in fade-in-0 slide-in-from-bottom-2 duration-150',
          maximized
            ? 'inset-6 m-auto h-[min(860px,calc(100vh-3rem))] w-[min(1000px,calc(100vw-3rem))] rounded-lg'
            : 'right-4 bottom-0 h-[min(600px,calc(100vh-4rem))] w-[540px] rounded-t-lg',
          'max-md:inset-0 max-md:h-full max-md:w-full max-md:rounded-none',
        )}
      >
        <header className="flex h-10 shrink-0 items-center gap-1 border-b bg-sidebar pr-1 pl-4">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h2>
          <WindowButton
            label="Minimize"
            onClick={() => setMode('minimized')}
            className="max-md:hidden"
          >
            <Minus />
          </WindowButton>
          <WindowButton
            label={maximized ? 'Exit full screen' : 'Full screen'}
            onClick={() => setMode(maximized ? 'normal' : 'maximized')}
            className="max-md:hidden"
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </WindowButton>
          <WindowButton label="Close" onClick={close}>
            <X />
          </WindowButton>
        </header>

        <div className="shrink-0 divide-y px-4 text-[13px]">
          <Field label="From" htmlFor="compose-from">
            <input
              id="compose-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="you@your-domain.com"
              autoComplete="email"
              className={fieldInput}
            />
            <input
              aria-label="Sender name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Name (optional)"
              className={cn(
                fieldInput,
                'max-w-40 text-right text-muted-foreground focus:text-foreground',
              )}
            />
          </Field>
          <Field label="To" htmlFor="compose-to">
            <input
              id="compose-to"
              ref={toInput}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Recipients, comma-separated"
              className={fieldInput}
            />
            {!showCcBcc && (
              <button
                type="button"
                onClick={() => setShowCcBcc(true)}
                className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Cc Bcc
              </button>
            )}
          </Field>
          {showCcBcc && (
            <>
              <Field label="Cc" htmlFor="compose-cc">
                <input
                  id="compose-cc"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  className={fieldInput}
                />
              </Field>
              <Field label="Bcc" htmlFor="compose-bcc">
                <input
                  id="compose-bcc"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  className={fieldInput}
                />
              </Field>
            </>
          )}
          <Field label="Subject" htmlFor="compose-subject" hideLabel>
            <input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className={cn(fieldInput, 'font-medium')}
            />
          </Field>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t px-4 py-3">
          {editor && <RichTextBody editor={editor} className="h-full" />}
        </div>

        {files.length > 0 && (
          <ul aria-label="Attachments" className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex max-w-56 items-center gap-1.5 rounded-md border bg-muted/50 py-1 pr-1 pl-2 text-xs"
              >
                <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                  className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {editor && showToolbar && (
          <div className="shrink-0 border-t px-3 py-1">
            <FormattingToolbar editor={editor} />
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-1 border-t px-3 py-2">
          <Button size="sm" onClick={() => void send()} disabled={busy} className="px-4">
            {busy ? (progress ?? 'Sending…') : 'Send'}
          </Button>
          <span className="ml-1 hidden text-[11px] text-muted-foreground sm:inline">⌘↵</span>
          <WindowButton
            label={showToolbar ? 'Hide formatting' : 'Show formatting'}
            onClick={() => setShowToolbar((v) => !v)}
            className={cn('ml-2', showToolbar && 'text-foreground')}
          >
            <Type />
          </WindowButton>
          <WindowButton label="Attach files" onClick={() => fileInput.current?.click()}>
            <Paperclip />
          </WindowButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles((prev) => [...prev, ...picked]);
              e.target.value = '';
            }}
          />
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {error ? (
              <p role="alert" className="truncate text-xs text-destructive">
                {error}
              </p>
            ) : (
              savedAt && <span className="truncate text-xs text-muted-foreground">Draft saved</span>
            )}
            <WindowButton label="Discard draft" onClick={discard}>
              <Trash2 />
            </WindowButton>
          </div>
        </footer>
      </section>
    </>
  );
}

const fieldInput =
  'h-9 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/80';

function Field(props: {
  label: string;
  htmlFor: string;
  hideLabel?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 focus-within:border-primary/40">
      <label
        htmlFor={props.htmlFor}
        className={cn('w-12 shrink-0 text-muted-foreground', props.hideLabel && 'sr-only')}
      >
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function WindowButton(props: {
  label: string;
  onClick: () => void;
  className?: string;
  dark?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={props.label}
          onClick={props.onClick}
          className={cn(
            'size-7 text-muted-foreground [&_svg]:size-4',
            props.dark && 'text-background/70 hover:bg-white/10 hover:text-background',
            props.className,
          )}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}
