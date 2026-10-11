import { describe, expect, it } from 'vitest';
import type { EmailSummary } from '../../src/data/emails-dao.js';
import { hasTextFilters, matchesListFilters, sortKeyBounds } from '../../src/utils/list-filter.js';

const inbound = {
  direction: 'inbound',
  pk: 'INBOUND',
  sk: '2026-10-01T09:00:00.000Z#i1',
  id: 'i1',
  from: 'alice@Example.com',
  fromName: 'Alice Wong',
  to: ['me@mine.dev'],
  cc: ['ops@mine.dev'],
  subject: 'Invoice #42 for October',
  snippet: 'Please find the PDF attached',
  receivedAt: '2026-10-01T09:00:00.000Z',
  hasAttachments: true,
  attachmentCount: 1,
  quarantined: false,
  spamVerdict: 'PASS',
  virusVerdict: 'PASS',
  parseStatus: 'ok',
} as EmailSummary;

const sent = {
  direction: 'sent',
  pk: 'SENT',
  sk: '2026-10-02T09:00:00.000Z#s1',
  id: 's1',
  from: 'agent@mine.dev',
  to: ['bob@other.org'],
  cc: [],
  subject: 'Re: lunch',
  sentAt: '2026-10-02T09:00:00.000Z',
  attachmentCount: 0,
} as EmailSummary;

describe('matchesListFilters', () => {
  it.each([
    [{ subject: 'invoice' }, true],
    [{ subject: 'INVOICE #42' }, true],
    [{ subject: 'receipt' }, false],
    [{ from: 'example.COM' }, true],
    [{ from: 'wong' }, true], // display name
    [{ from: 'mine.dev' }, false], // a recipient, not the sender
    [{ to: 'ops@' }, true], // cc counts
    [{ to: 'alice' }, false],
    [{ query: 'pdf' }, true], // preview
    [{ query: 'ops@mine' }, true],
    [{ query: 'alice' }, true],
    [{ query: 'nowhere' }, false],
    [{ subject: 'invoice', from: 'alice' }, true],
    [{ subject: 'invoice', from: 'bob' }, false], // every filter must match
  ])('%o → %s on a received row', (filters, expected) => {
    expect(matchesListFilters(inbound, filters)).toBe(expected);
  });

  it('matches a sent row by its sender and recipients', () => {
    expect(matchesListFilters(sent, { to: 'bob@' })).toBe(true);
    expect(matchesListFilters(sent, { from: 'agent' })).toBe(true);
    expect(matchesListFilters(sent, { query: 'lunch' })).toBe(true);
  });
});

describe('hasTextFilters', () => {
  it('is false for no filters or a date range alone', () => {
    expect(hasTextFilters(undefined)).toBe(false);
    expect(hasTextFilters({ after: '2026-10-01T00:00:00.000Z' })).toBe(false);
  });

  it('is true with any text filter', () => {
    expect(hasTextFilters({ to: 'x' })).toBe(true);
  });
});

describe('sortKeyBounds', () => {
  it('keeps rows AT `after` and drops rows AT `before`', () => {
    const bounds = sortKeyBounds({
      after: '2026-10-01T00:00:00.000Z',
      before: '2026-10-02T00:00:00.000Z',
    });
    const inRange = (sk: string) => sk >= bounds.minSk! && sk <= bounds.maxSk!;

    expect(inRange('2026-10-01T00:00:00.000Z#a')).toBe(true);
    expect(inRange('2026-10-01T23:59:59.999Z#b')).toBe(true);
    expect(inRange('2026-10-02T00:00:00.000Z#c')).toBe(false);
    expect(inRange('2026-09-30T23:59:59.999Z#d')).toBe(false);
  });

  it('is empty without a date range', () => {
    expect(sortKeyBounds({ query: 'x' })).toEqual({});
  });
});
