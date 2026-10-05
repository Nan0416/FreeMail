import { describe, expect, it } from 'vitest';
import type { EmailListItem } from '@freemail/shared';
import { applyListView, DEFAULT_VIEW } from '../../src/lib/mail-filter.js';

function item(id: string, over: Partial<EmailListItem> = {}): EmailListItem {
  return {
    id,
    direction: 'inbound',
    from: `${id}@x.com`,
    to: ['me@y.com'],
    cc: [],
    subject: `Subject ${id}`,
    date: '2026-07-17T00:00:00.000Z',
    hasAttachments: false,
    attachmentCount: 0,
    ...over,
  };
}

const EMAILS = [
  item('a', { fromName: 'Alice Smith', subject: 'Quarterly report', hasAttachments: true }),
  item('b', { snippet: 'lunch on friday?' }),
  item('c', { quarantined: true }),
];

const ids = (list: readonly EmailListItem[]) => list.map((e) => e.id);

describe('applyListView', () => {
  it('returns everything, newest first, by default', () => {
    expect(ids(applyListView(EMAILS, DEFAULT_VIEW))).toEqual(['a', 'b', 'c']);
  });

  it('matches every search term across sender, subject and snippet, case-insensitively', () => {
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, query: 'alice REPORT' }))).toEqual(['a']);
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, query: 'friday' }))).toEqual(['b']);
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, query: 'alice friday' }))).toEqual([]);
  });

  it('filters to attachments or spam', () => {
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, filter: 'attachments' }))).toEqual(['a']);
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, filter: 'spam' }))).toEqual(['c']);
  });

  it('reverses for oldest-first without mutating the input', () => {
    expect(ids(applyListView(EMAILS, { ...DEFAULT_VIEW, sort: 'oldest' }))).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(ids(EMAILS)).toEqual(['a', 'b', 'c']);
  });
});
