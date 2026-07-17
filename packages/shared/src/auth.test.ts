import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from './auth.js';

describe('passwordPolicyError', () => {
  it('rejects passwords shorter than the minimum', () => {
    expect(passwordPolicyError('short')).toBe('weak_password');
    expect(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('weak_password');
  });

  it('accepts passwords at or above the minimum length', () => {
    expect(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordPolicyError('a-perfectly-fine-passphrase')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(passwordPolicyError(undefined as unknown as string)).toBe('weak_password');
  });
});
