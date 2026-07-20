import { DEFAULT_EMAIL_PAGE_SIZE, MAX_EMAIL_PAGE_SIZE } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import { EmailError } from '../../src/email/errors.js';
import { parseListEmailsQuery } from '../../src/email/list-query.js';

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
