import { describe, expect, it } from 'vitest';
import { fitBodyToBudget, truncateToUtf8Bytes } from './body-budget.js';

function jsonBytes(text: string | undefined, html: string | undefined): number {
  return Buffer.byteLength(JSON.stringify({ text, html }), 'utf8');
}

describe('truncateToUtf8Bytes', () => {
  it('is a no-op when already under the byte budget', () => {
    expect(truncateToUtf8Bytes('hello', 100)).toEqual({ value: 'hello', truncated: false });
  });

  it('cuts ASCII to the byte budget', () => {
    const r = truncateToUtf8Bytes('a'.repeat(100), 10);
    expect(r.value).toBe('aaaaaaaaaa');
    expect(r.truncated).toBe(true);
  });

  it('never splits a multi-byte character (backs off to a char boundary)', () => {
    // '€' = 3 UTF-8 bytes; a 4-byte budget fits exactly one and must not split the next.
    const r = truncateToUtf8Bytes('€€€', 4);
    expect(r.value).toBe('€');
    expect(Buffer.byteLength(r.value, 'utf8')).toBeLessThanOrEqual(4);
    expect(r.value).not.toContain('�'); // no replacement char from a split sequence
    expect(r.truncated).toBe(true);
  });
});

describe('fitBodyToBudget', () => {
  it('passes normal small bodies through untouched', () => {
    const r = fitBodyToBudget('plain', '<p>hi</p>', {
      partCapBytes: 1000,
      serializedBudgetBytes: 1000,
    });
    expect(r).toEqual({ text: 'plain', html: '<p>hi</p>', truncated: false });
  });

  it('caps each part to the per-part byte budget', () => {
    const r = fitBodyToBudget('t'.repeat(50), 'h'.repeat(50), {
      partCapBytes: 10,
      serializedBudgetBytes: 10_000,
    });
    expect(Buffer.byteLength(r.text ?? '', 'utf8')).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(r.html ?? '', 'utf8')).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true);
  });

  it('omits an absent part', () => {
    const r = fitBodyToBudget(undefined, '<p>x</p>', {
      partCapBytes: 1000,
      serializedBudgetBytes: 1000,
    });
    expect(r.text).toBeUndefined();
    expect(r.html).toBe('<p>x</p>');
    expect(r.truncated).toBe(false);
  });

  it('shrinks a JSON-inflating (control-char-dense) body under the serialized budget', () => {
    // Each control char JSON-escapes to a 6-byte \u00XX, so the per-part BYTE cap alone
    // cannot bound the serialized size — the second layer must shrink it.
    const dense = '\x01'.repeat(4000);
    const budget = 2000;
    const r = fitBodyToBudget(dense, dense, {
      partCapBytes: 1_000_000,
      serializedBudgetBytes: budget,
    });
    expect(jsonBytes(r.text, r.html)).toBeLessThanOrEqual(budget);
    expect(r.truncated).toBe(true);
  });

  it('terminates and stays under budget for a huge control-char body', () => {
    const huge = '\x02'.repeat(200_000);
    const r = fitBodyToBudget(huge, huge, {
      partCapBytes: 500_000,
      serializedBudgetBytes: 1024,
    });
    expect(jsonBytes(r.text, r.html)).toBeLessThanOrEqual(1024);
    expect(r.truncated).toBe(true);
  });
});
