import { useSyncExternalStore } from 'react';

/**
 * Drafts live in THIS browser only. The API has no drafts endpoint, so a draft is a
 * convenience copy in `localStorage`: it never reaches the server until it is sent, does
 * not follow you to another device, and attachments are not kept (a `File` cannot be
 * persisted). Every storage access is guarded — a private window or blocked site data
 * makes storage throw, and the app must still work, just without drafts.
 */
export interface Draft {
  readonly id: string;
  readonly from: string;
  /** Optional display name for the From header. */
  readonly fromName?: string;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  /** Editor HTML. */
  readonly html: string;
  /** ISO-8601. */
  readonly updatedAt: string;
}

const DRAFTS_KEY = 'freemail.drafts.v1';
const SENDER_KEY = 'freemail.sender.v1';

const EMPTY: readonly Draft[] = [];
let cache: readonly Draft[] | null = null;
const listeners = new Set<() => void>();

function read(): readonly Draft[] {
  if (cache) {
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as Draft[]) : EMPTY;
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function write(next: readonly Draft[]): void {
  cache = next;
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the draft lives for this session only.
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All drafts, newest first; re-renders on change. */
export function useDrafts(): readonly Draft[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function saveDraft(draft: Draft): void {
  write([draft, ...read().filter((d) => d.id !== draft.id)]);
}

export function deleteDraft(id: string): void {
  write(read().filter((d) => d.id !== id));
}

export function newDraftId(): string {
  return `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface Sender {
  readonly address: string;
  readonly name: string;
}

/** The identity mail was last sent as, to prefill the next compose. */
export function getLastSender(): Sender {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SENDER_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const sender = parsed as Partial<Sender>;
      return {
        address: typeof sender.address === 'string' ? sender.address : '',
        name: typeof sender.name === 'string' ? sender.name : '',
      };
    }
  } catch {
    // Unreadable storage: no prefill.
  }
  return { address: '', name: '' };
}

export function setLastSender(sender: Sender): void {
  try {
    window.localStorage.setItem(SENDER_KEY, JSON.stringify(sender));
  } catch {
    // Best effort.
  }
}

/** Test seam: forget the in-memory copy so the next read goes back to storage. */
export function resetDraftsCache(): void {
  cache = null;
}
