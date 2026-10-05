import { describe, expect, it } from 'vitest';
import { avatarTint, initials, parseRecipients } from '../../src/lib/people.js';

describe('initials', () => {
  it('takes two words from a name, one letter from a single word', () => {
    expect(initials('Maya Chen', 'm@x.com')).toBe('MC');
    expect(initials('GitHub', 'noreply@github.com')).toBe('G');
  });

  it('falls back to the address local part', () => {
    expect(initials(undefined, 'jonas.weber@studio.de')).toBe('JW');
    expect(initials('  ', 'sam@x.com')).toBe('S');
  });
});

describe('avatarTint', () => {
  it('is stable per address, ignoring case', () => {
    expect(avatarTint('A@x.com')).toBe(avatarTint('a@x.com'));
  });
});

describe('parseRecipients', () => {
  it('splits on commas, semicolons and newlines and drops blanks', () => {
    expect(parseRecipients(' a@x.com, b@x.com;c@x.com\n\n , ')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });
});
