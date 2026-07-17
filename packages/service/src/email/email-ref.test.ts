import { describe, expect, it } from 'vitest';
import { EmailError } from './errors.js';
import { decodeEmailRef, encodeEmailRef } from './email-ref.js';

/** A base64url payload for an arbitrary (possibly hostile) handle body. */
function handleOf(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function expectNotFound(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected a not_found error');
  } catch (err) {
    expect(err).toBeInstanceOf(EmailError);
    expect((err as EmailError).code).toBe('not_found');
    expect((err as EmailError).status).toBe(404);
  }
}

describe('email-ref', () => {
  it('round-trips a primary key through an opaque handle', () => {
    const ref = { pk: 'INBOUND', sk: '2026-07-17T10:00:00.000Z#ses-in-1' };
    const decoded = decodeEmailRef(encodeEmailRef(ref));
    expect(decoded).toEqual(ref);
  });

  it('accepts both real partitions', () => {
    for (const pk of ['SENT', 'INBOUND']) {
      const ref = { pk, sk: `2026-07-17T10:00:00.000Z#id` };
      expect(decodeEmailRef(encodeEmailRef(ref))).toEqual(ref);
    }
  });

  it('does not leak the raw key in the handle (opaque, not plaintext)', () => {
    const handle = encodeEmailRef({ pk: 'INBOUND', sk: 'x#y' });
    // It is base64url — reversible, not secret — but it is NOT the bare sk/pk string.
    expect(handle).not.toContain('INBOUND');
    expect(handle).not.toContain('#');
  });

  it('rejects a partition outside the known set → not_found (no arbitrary-partition probing)', () => {
    expectNotFound(() => decodeEmailRef(handleOf({ v: 1, pk: 'SECRETS', sk: 'a#b' })));
    expectNotFound(() => decodeEmailRef(handleOf({ v: 1, pk: '', sk: 'a#b' })));
  });

  it('rejects a wrong version, missing/empty sk, wrong types → not_found', () => {
    expectNotFound(() => decodeEmailRef(handleOf({ v: 2, pk: 'SENT', sk: 'a#b' })));
    expectNotFound(() => decodeEmailRef(handleOf({ v: 1, pk: 'SENT' })));
    expectNotFound(() => decodeEmailRef(handleOf({ v: 1, pk: 'SENT', sk: '' })));
    expectNotFound(() => decodeEmailRef(handleOf({ v: 1, pk: 42, sk: 'a#b' })));
    expectNotFound(() => decodeEmailRef(handleOf(['not', 'an', 'object'])));
    expectNotFound(() => decodeEmailRef(handleOf(null)));
  });

  it('rejects a malformed handle (not base64/JSON) → not_found', () => {
    expectNotFound(() => decodeEmailRef('!!!not base64!!!'));
    expectNotFound(() => decodeEmailRef(Buffer.from('not json', 'utf8').toString('base64url')));
    expectNotFound(() => decodeEmailRef(''));
  });
});
