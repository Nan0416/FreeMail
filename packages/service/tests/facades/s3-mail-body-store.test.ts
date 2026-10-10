import { describe, expect, it } from 'vitest';
import { parseStoredBody } from '../../src/facades/s3-mail-body-store.js';

describe('parseStoredBody', () => {
  it('reads back the JSON the store writes', () => {
    expect(
      parseStoredBody(JSON.stringify({ text: 't', html: '<p>h</p>', truncated: true })),
    ).toEqual({
      text: 't',
      html: '<p>h</p>',
      truncated: true,
    });
  });

  it('keeps only well-typed fields from a damaged object', () => {
    expect(
      parseStoredBody(JSON.stringify({ text: 42, html: '<p>ok</p>', truncated: 'yes' })),
    ).toEqual({
      html: '<p>ok</p>',
    });
  });

  it('yields no body for malformed JSON or a non-object', () => {
    expect(parseStoredBody('{not json')).toBeNull();
    expect(parseStoredBody('"a string"')).toBeNull();
    expect(parseStoredBody('[1, 2]')).toBeNull();
    expect(parseStoredBody('null')).toBeNull();
  });
});
