import { describe, expect, it } from 'vitest';
import { isSubdomainOrEqual, normalizeDomain } from '../src/domain.js';

describe('isSubdomainOrEqual', () => {
  it('accepts equal and subdomains, rejects unrelated', () => {
    expect(isSubdomainOrEqual('example.com', 'example.com')).toBe(true);
    expect(isSubdomainOrEqual('mail.example.com', 'example.com')).toBe(true);
    expect(isSubdomainOrEqual('notexample.com', 'example.com')).toBe(false);
    // A suffix match must not be mistaken for containment.
    expect(isSubdomainOrEqual('example.com.evil.com', 'example.com')).toBe(false);
  });
});

describe('normalizeDomain', () => {
  it('trims, lowercases, and drops a trailing dot', () => {
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com');
    expect(normalizeDomain('mail.example.com')).toBe('mail.example.com');
  });
});
