import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDraft,
  getLastSender,
  resetDraftsCache,
  saveDraft,
  setLastSender,
  type Draft,
} from '../../src/lib/drafts.js';

function draft(id: string, subject = id): Draft {
  return {
    id,
    from: '',
    to: '',
    cc: '',
    bcc: '',
    subject,
    html: '',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function stored(): Draft[] {
  return JSON.parse(window.localStorage.getItem('freemail.drafts.v1') ?? '[]');
}

beforeEach(() => {
  window.localStorage.clear();
  resetDraftsCache();
});

describe('drafts store', () => {
  it('keeps the most recently saved draft first, replacing by id', () => {
    saveDraft(draft('a'));
    saveDraft(draft('b'));
    saveDraft(draft('a', 'a2'));
    expect(stored().map((d) => d.subject)).toEqual(['a2', 'b']);
    deleteDraft('a');
    expect(stored().map((d) => d.id)).toEqual(['b']);
  });

  it('tolerates corrupt storage', () => {
    window.localStorage.setItem('freemail.drafts.v1', '{not json');
    saveDraft(draft('a'));
    expect(stored().map((d) => d.id)).toEqual(['a']);
  });

  it('keeps working in memory when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      expect(() => saveDraft(draft('a'))).not.toThrow();
      expect(() => setLastSender({ address: 'me@x.com', name: '' })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('last sender', () => {
  it('round-trips, and reads as blank when absent or malformed', () => {
    expect(getLastSender()).toEqual({ address: '', name: '' });
    setLastSender({ address: 'me@x.com', name: 'Me' });
    expect(getLastSender()).toEqual({ address: 'me@x.com', name: 'Me' });
    window.localStorage.setItem('freemail.sender.v1', '"just a string"');
    expect(getLastSender()).toEqual({ address: '', name: '' });
  });
});
