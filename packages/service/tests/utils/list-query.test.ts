import { DEFAULT_EMAIL_PAGE_SIZE, MAX_EMAIL_PAGE_SIZE } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import { EmailError } from '../../src/utils/errors.js';
import { parseListEmailsQuery } from '../../src/utils/list-query.js';

describe('parseListEmailsQuery', () => {
  it('defaults limit and omits direction/cursor when absent', () => {
    expect(parseListEmailsQuery({})).toEqual({ limit: DEFAULT_EMAIL_PAGE_SIZE });
  });

  it('treats empty-string direction/cursor and empty-string limit as absent (query-string shape)', () => {
    expect(parseListEmailsQuery({ direction: '', limit: '', cursor: '' })).toEqual({
      limit: DEFAULT_EMAIL_PAGE_SIZE,
    });
  });

  it('accepts a valid direction and opaque cursor', () => {
    expect(parseListEmailsQuery({ direction: 'inbound', cursor: 'abc' })).toEqual({
      limit: DEFAULT_EMAIL_PAGE_SIZE,
      direction: 'inbound',
      cursor: 'abc',
    });
    expect(parseListEmailsQuery({ direction: 'sent' }).direction).toBe('sent');
  });

  it('accepts "failed" — the Errors folder', () => {
    expect(parseListEmailsQuery({ direction: 'failed' }).direction).toBe('failed');
  });

  it('rejects an unknown direction with an EmailError', () => {
    expect(() => parseListEmailsQuery({ direction: 'drafts' })).toThrow(EmailError);
    expect(() => parseListEmailsQuery({ direction: 'drafts' })).toThrow(/"direction" must be/);
  });

  it('parses a numeric limit and a numeric-string limit identically', () => {
    expect(parseListEmailsQuery({ limit: 10 }).limit).toBe(10);
    expect(parseListEmailsQuery({ limit: '10' }).limit).toBe(10);
  });

  it('clamps a limit above the max to the max', () => {
    expect(parseListEmailsQuery({ limit: MAX_EMAIL_PAGE_SIZE + 500 }).limit).toBe(
      MAX_EMAIL_PAGE_SIZE,
    );
    expect(parseListEmailsQuery({ limit: '9999' }).limit).toBe(MAX_EMAIL_PAGE_SIZE);
  });

  it('rejects a non-integer or non-positive limit (number or string)', () => {
    for (const bad of [0, -1, 2.5, '0', '-3', 'abc', '2.5']) {
      expect(() => parseListEmailsQuery({ limit: bad })).toThrow(EmailError);
    }
  });
});

describe('parseListEmailsQuery — search filters', () => {
  it('omits filters when none are set, or all are blank', () => {
    expect(parseListEmailsQuery({}).filters).toBeUndefined();
    expect(parseListEmailsQuery({ query: '  ', from: '' }).filters).toBeUndefined();
  });

  it('trims the text filters', () => {
    expect(parseListEmailsQuery({ query: ' invoice ', to: 'bob@' }).filters).toEqual({
      query: 'invoice',
      to: 'bob@',
    });
  });

  it('rejects a text filter over the length cap', () => {
    expect(() => parseListEmailsQuery({ subject: 'x'.repeat(201) })).toThrow(/at most 200/);
  });

  it.each([
    ['2026-10-01', '2026-10-01T00:00:00.000Z'],
    ['2026-10-01T09:30Z', '2026-10-01T09:30:00.000Z'],
    ['2026-10-01T09:30:15.5Z', '2026-10-01T09:30:15.500Z'],
    ['2026-10-01T09:30:00+02:00', '2026-10-01T07:30:00.000Z'],
  ])('normalizes after=%s to UTC', (raw, iso) => {
    expect(parseListEmailsQuery({ after: raw }).filters).toEqual({ after: iso });
  });

  it('accepts and truncates sub-millisecond fractions', () => {
    expect(parseListEmailsQuery({ after: '2026-10-01T09:30:15.123456+00:00' }).filters).toEqual({
      after: '2026-10-01T09:30:15.123Z',
    });
  });

  it.each([
    'yesterday',
    '2026-10-01T09:30',
    '2026-13-01',
    '10/01/2026',
    '2026-10-01 09:00Z',
    '2026-02-30',
    '2026-04-31',
    '2026-02-29',
    '9999-12-31T23:00-05:00',
  ])('rejects before=%s', (raw) => {
    expect(() => parseListEmailsQuery({ before: raw })).toThrow(EmailError);
  });

  it('rejects an empty range', () => {
    expect(() => parseListEmailsQuery({ after: '2026-10-02', before: '2026-10-01' })).toThrow(
      /earlier than/,
    );
    expect(() => parseListEmailsQuery({ after: '2026-10-01', before: '2026-10-01' })).toThrow(
      /earlier than/,
    );
  });
});
