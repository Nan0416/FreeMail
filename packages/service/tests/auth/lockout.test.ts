import { describe, expect, it } from 'vitest';
import {
  FAILURE_WINDOW_SECONDS,
  INITIAL_LOCKOUT_STATE,
  LOCKOUT_SECONDS,
  MAX_FAILED_ATTEMPTS,
  clearFailures,
  isLockedOut,
  registerFailure,
  retryAfterSeconds,
} from '../../src/auth/lockout.js';

describe('lockout policy', () => {
  it('counts the first failure and does not lock', () => {
    const next = registerFailure(INITIAL_LOCKOUT_STATE, 100);
    expect(next.failedCount).toBe(1);
    expect(next.windowStartedAt).toBe(100);
    expect(isLockedOut(next, 100)).toBe(false);
  });

  it('locks once the threshold is reached within the window', () => {
    let state = INITIAL_LOCKOUT_STATE;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      state = registerFailure(state, 100 + i);
    }
    expect(state.failedCount).toBe(MAX_FAILED_ATTEMPTS);
    const lockedAt = 100 + MAX_FAILED_ATTEMPTS - 1;
    expect(isLockedOut(state, lockedAt)).toBe(true);
    expect(state.lockedUntil).toBe(lockedAt + LOCKOUT_SECONDS);
    expect(retryAfterSeconds(state, lockedAt)).toBe(LOCKOUT_SECONDS);
  });

  it('starts a fresh window after the failure window elapses', () => {
    const stale = { failedCount: 3, windowStartedAt: 100 };
    const next = registerFailure(stale, 100 + FAILURE_WINDOW_SECONDS);
    expect(next.failedCount).toBe(1);
    expect(next.windowStartedAt).toBe(100 + FAILURE_WINDOW_SECONDS);
  });

  it('reports the lock as lifted once lockedUntil passes', () => {
    const state = { failedCount: MAX_FAILED_ATTEMPTS, windowStartedAt: 100, lockedUntil: 200 };
    expect(isLockedOut(state, 199)).toBe(true);
    expect(isLockedOut(state, 200)).toBe(false);
    expect(retryAfterSeconds(state, 200)).toBe(0);
  });

  it('clears back to the initial state', () => {
    expect(clearFailures()).toEqual(INITIAL_LOCKOUT_STATE);
  });
});
