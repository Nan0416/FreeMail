import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('round-trips a correct password', () => {
    const encoded = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', encoded)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const encoded = hashPassword('correct horse battery staple');
    expect(verifyPassword('Correct horse battery staple', encoded)).toBe(false);
    expect(verifyPassword('', encoded)).toBe(false);
  });

  it('uses a fresh salt per hash (no deterministic output)', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });

  it('produces the self-describing scrypt encoding', () => {
    const encoded = hashPassword('another-password-value');
    expect(encoded.split('$')).toHaveLength(6);
    expect(encoded.startsWith('scrypt$16384$8$1$')).toBe(true);
  });

  it('returns false (never throws) for malformed encodings', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(verifyPassword('x', 'scrypt$16384$8$1$@@@$@@@')).toBe(false);
    expect(verifyPassword('x', 'scrypt$notnum$8$1$AAAA$AAAA')).toBe(false);
  });
});
