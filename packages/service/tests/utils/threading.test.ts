import { describe, expect, it } from 'vitest';
import {
  MAX_REFERENCES,
  replyReferences,
  replySubject,
  sanitizeMessageId,
  sanitizeReferences,
  sesMessageIdHeader,
} from '../../src/utils/threading.js';

describe('sanitizeMessageId', () => {
  it('keeps one well-formed id, trimmed', () => {
    expect(sanitizeMessageId('  <CAH+x=y@mail.gmail.com> ')).toBe('<CAH+x=y@mail.gmail.com>');
  });

  it('takes the first of a repeated header', () => {
    expect(sanitizeMessageId(['<a@x>', '<b@x>'])).toBe('<a@x>');
  });

  it.each([
    ['no brackets', 'a@x'],
    ['whitespace inside', '<a b@x>'],
    ['header injection', '<a@x>\r\nBcc: victim@evil.test'],
    ['an angle bracket inside', '<a<b@x>'],
    ['empty', '<>'],
    ['non-ASCII', '<café@x>'],
    ['too long', `<${'a'.repeat(251)}>`],
    ['not a string', 42],
  ])('drops %s', (_label, value) => {
    expect(sanitizeMessageId(value)).toBeUndefined();
  });
});

describe('sanitizeReferences', () => {
  it('splits, validates, and de-duplicates the ids in order', () => {
    expect(sanitizeReferences('<a@x> <b@x>\r\n <a@x> junk <c@x>')).toEqual([
      '<a@x>',
      '<b@x>',
      '<c@x>',
    ]);
  });

  it('accepts the list form mailparser produces', () => {
    expect(sanitizeReferences(['<a@x>', '<b@x> <c@x>'])).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  it('keeps the root and the newest ids when the chain is too long', () => {
    const ids = Array.from({ length: 30 }, (_v, i) => `<m${i}@x>`);
    const kept = sanitizeReferences(ids.join(' '));
    expect(kept).toHaveLength(MAX_REFERENCES);
    expect(kept[0]).toBe('<m0@x>');
    expect(kept.at(-1)).toBe('<m29@x>');
    expect(kept[1]).toBe(`<m${30 - (MAX_REFERENCES - 1)}@x>`);
  });

  it('returns nothing for an absent header', () => {
    expect(sanitizeReferences(undefined)).toEqual([]);
  });
});

describe('replyReferences', () => {
  it("appends the parent's id to its chain", () => {
    expect(replyReferences(['<a@x>', '<b@x>'], '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  it('starts a chain for a parent without one', () => {
    expect(replyReferences(undefined, '<c@x>')).toEqual(['<c@x>']);
  });

  it("never repeats the parent's id", () => {
    expect(replyReferences(['<c@x>', '<a@x>'], '<c@x>')).toEqual(['<a@x>', '<c@x>']);
  });
});

describe('sesMessageIdHeader', () => {
  it('uses email.amazonses.com in us-east-1 (as observed on live mail)', () => {
    expect(
      sesMessageIdHeader(
        '010001a127d4e2c6-6b953257-49ba-46a0-b091-e88f141336c4-000000',
        'us-east-1',
      ),
    ).toBe('<010001a127d4e2c6-6b953257-49ba-46a0-b091-e88f141336c4-000000@email.amazonses.com>');
  });

  it('uses the region host elsewhere', () => {
    expect(sesMessageIdHeader('abc', 'eu-west-1')).toBe('<abc@eu-west-1.amazonses.com>');
  });
});

describe('replySubject', () => {
  it.each([
    ['Lunch?', 'Re: Lunch?'],
    ['Re: Lunch?', 'Re: Lunch?'],
    ['RE:Lunch?', 'RE:Lunch?'],
    ['  spaced  ', 'Re: spaced'],
    ['', 'Re:'],
  ])('%j → %j', (subject, expected) => {
    expect(replySubject(subject)).toBe(expected);
  });
});
