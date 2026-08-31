import { describe, expect, it } from 'vitest';
import {
  hasJsonContentType,
  isJsonContentType,
  readContentType,
} from '../../src/handlers/content-type.js';

describe('isJsonContentType', () => {
  it('accepts the bare media type', () => {
    expect(isJsonContentType('application/json')).toBe(true);
  });

  it('accepts it case-insensitively', () => {
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
    expect(isJsonContentType('Application/Json')).toBe(true);
  });

  it('tolerates parameters and surrounding whitespace', () => {
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('  application/json ; charset=UTF-8 ')).toBe(true);
    expect(isJsonContentType('application/json;charset=utf-8')).toBe(true);
  });

  it('rejects the simple-request media types a form-POST can send', () => {
    // These are exactly the types that let a same-site sibling POST without a preflight.
    expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonContentType('multipart/form-data')).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
  });

  it('rejects lookalike media types rather than prefix-matching', () => {
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
    expect(isJsonContentType('application/jsonx')).toBe(false);
    expect(isJsonContentType('text/application/json')).toBe(false);
  });

  it('rejects an absent or empty header', () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
  });
});

describe('readContentType', () => {
  it('finds the header regardless of case', () => {
    expect(readContentType({ 'Content-Type': 'application/json' })).toBe('application/json');
    expect(readContentType({ 'CONTENT-TYPE': 'application/json' })).toBe('application/json');
  });

  it('returns undefined for absent headers', () => {
    expect(readContentType(undefined)).toBeUndefined();
    expect(readContentType({})).toBeUndefined();
    expect(readContentType({ accept: 'application/json' })).toBeUndefined();
  });
});

describe('hasJsonContentType', () => {
  it('combines the lookup and the media-type check', () => {
    expect(hasJsonContentType({ 'Content-Type': 'application/json; charset=utf-8' })).toBe(true);
    expect(hasJsonContentType({ 'content-type': 'text/plain' })).toBe(false);
    expect(hasJsonContentType(undefined)).toBe(false);
  });
});
