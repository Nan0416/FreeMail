import { FileText, Menu, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { deleteDraft, saveDraft, type Draft } from '../lib/drafts.js';
import { formatListDate } from '../lib/format.js';

export interface DraftListProps {
  readonly drafts: readonly Draft[];
  readonly onOpen: (draft: Draft) => void;
  readonly onOpenNav: () => void;
}

function previewOf(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Browser-local drafts (see `lib/drafts.ts`). Opening one resumes it in the compose window. */
export function DraftList(props: DraftListProps): React.JSX.Element {
  return (
    <section aria-label="Drafts" className="flex h-full min-w-0 flex-col">
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
        <h1 className="text-[15px] font-semibold tracking-tight">Drafts</h1>
        {props.drafts.length > 0 && (
          <span className="ml-1 text-xs text-muted-foreground tabular-nums">
            {props.drafts.length}
          </span>
        )}
      </header>
      <p className="shrink-0 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        Drafts are saved in this browser only. Attachments aren&rsquo;t kept.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.drafts.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <FileText className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
            <p className="mt-3 text-[13px] text-muted-foreground">No drafts.</p>
          </div>
        ) : (
          <ul aria-label="Drafts" className="divide-y divide-border/70">
            {props.drafts.map((draft) => {
              const preview = previewOf(draft.html);
              return (
                <li key={draft.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => props.onOpen(draft)}
                    className="block w-full px-4 py-2.5 pr-12 text-left transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        <span className="text-destructive/90">Draft</span>
                        {draft.to.trim() && (
                          <span className="text-foreground"> · To: {draft.to}</span>
                        )}
                      </span>
                      <time
                        dateTime={draft.updatedAt}
                        className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      >
                        {formatListDate(draft.updatedAt)}
                      </time>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px]">
                      <span className="text-foreground/90">{draft.subject || '(no subject)'}</span>
                      {preview && <span className="text-muted-foreground"> — {preview}</span>}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Discard draft"
                    className="absolute top-1/2 right-2 size-7 -translate-y-1/2 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    onClick={() => {
                      deleteDraft(draft.id);
                      toast('Draft discarded', {
                        action: { label: 'Undo', onClick: () => saveDraft(draft) },
                      });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
