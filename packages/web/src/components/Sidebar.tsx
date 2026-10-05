import { FileText, Inbox, KeyRound, Layers, LogOut, Mail, PenSquare, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from './Kbd.js';
import { cn } from '@/lib/utils';

export type FolderId = 'inbox' | 'all' | 'sent' | 'drafts' | 'keys';

interface NavItem {
  readonly id: FolderId;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface SidebarProps {
  readonly folder: FolderId;
  readonly onSelectFolder: (folder: FolderId) => void;
  readonly onCompose: () => void;
  readonly inboundEnabled: boolean;
  readonly draftCount: number;
  readonly subject: string | null;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}

/** Folder navigation + compose + account. Compact by design: the list and reader get the room. */
export function Sidebar({
  folder,
  onSelectFolder,
  onCompose,
  inboundEnabled,
  draftCount,
  subject,
  signingOut,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const mail: readonly NavItem[] = [
    ...(inboundEnabled ? [{ id: 'inbox' as const, label: 'Inbox', icon: Inbox }] : []),
    { id: 'sent', label: 'Sent', icon: Send },
    { id: 'drafts', label: 'Drafts', icon: FileText },
    ...(inboundEnabled ? [{ id: 'all' as const, label: 'All mail', icon: Layers }] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Mail className="size-3.5" strokeWidth={2.25} />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">FreeMail</span>
      </div>

      <div className="px-3 pt-1 pb-3">
        <Button className="w-full justify-start gap-2 shadow-none" onClick={onCompose}>
          <PenSquare className="size-4" />
          Compose
          <Kbd className="ml-auto border-white/25 bg-white/10 text-primary-foreground/80">C</Kbd>
        </Button>
      </div>

      <nav aria-label="Folders" className="flex-1 overflow-y-auto px-2">
        <ul className="space-y-px">
          {mail.map((item) => (
            <NavRow
              key={item.id}
              item={item}
              active={folder === item.id}
              count={item.id === 'drafts' ? draftCount : undefined}
              onSelect={onSelectFolder}
            />
          ))}
        </ul>
        <p className="mt-5 mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Developers
        </p>
        <ul>
          <NavRow
            item={{ id: 'keys', label: 'API keys', icon: KeyRound }}
            active={folder === 'keys'}
            onSelect={onSelectFolder}
          />
        </ul>
      </nav>

      <div className="border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-medium">
                {(subject ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {subject ?? 'Account'}
                </span>
                <span className="block text-xs text-muted-foreground">Signed in</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Signed in as {subject}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSelectFolder('keys')}>
              <KeyRound />
              API keys
            </DropdownMenuItem>
            <DropdownMenuItem disabled={signingOut} onSelect={onSignOut}>
              <LogOut />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function NavRow({
  item,
  active,
  count,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  count?: number;
  onSelect: (folder: FolderId) => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(item.id)}
        className={cn(
          'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          active
            ? 'bg-selected font-medium text-selected-foreground'
            : 'text-foreground/80 hover:bg-accent hover:text-foreground',
        )}
      >
        <Icon
          className={cn('size-4', active ? 'text-selected-foreground' : 'text-muted-foreground')}
        />
        <span className="flex-1 text-left">{item.label}</span>
        {count !== undefined && count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
      </button>
    </li>
  );
}
