/**
 * Login rate-limit / lockout policy — pure state transitions, no I/O, so the
 * whole brute-force decision is unit-testable. A single password on a public
 * endpoint is the brute-force target, so failures are counted within a sliding
 * window and, past a threshold, the endpoint locks for a cooldown.
 *
 * The state is persisted by the repository (one row); this module only decides
 * the next state and whether a request is currently allowed.
 */

/** Failures allowed within the window before the account locks. */
export const MAX_FAILED_ATTEMPTS = 5;

/** Sliding window over which failures accumulate (seconds). */
export const FAILURE_WINDOW_SECONDS = 15 * 60;

/** How long the endpoint stays locked once the threshold is hit (seconds). */
export const LOCKOUT_SECONDS = 15 * 60;

export interface LockoutState {
  /** Failures counted in the current window. */
  readonly failedCount: number;
  /** Epoch seconds of the first failure in the current window. */
  readonly windowStartedAt: number;
  /** Epoch seconds until which login is locked, if any. */
  readonly lockedUntil?: number;
}

export const INITIAL_LOCKOUT_STATE: LockoutState = { failedCount: 0, windowStartedAt: 0 };

/** True when login is currently locked out. */
export function isLockedOut(state: LockoutState, nowSeconds: number): boolean {
  return state.lockedUntil !== undefined && state.lockedUntil > nowSeconds;
}

/**
 * Fold a failed attempt into the state. Failures outside the window start a fresh
 * window; reaching the threshold sets `lockedUntil`. The returned state is what
 * the caller persists.
 */
export function registerFailure(state: LockoutState, nowSeconds: number): LockoutState {
  // A still-active lock counts further attempts against the existing window (no early expiry).
  const windowExpired = nowSeconds - state.windowStartedAt >= FAILURE_WINDOW_SECONDS;
  const inFreshWindow = state.failedCount === 0 || windowExpired;

  const next: LockoutState = inFreshWindow
    ? { failedCount: 1, windowStartedAt: nowSeconds }
    : { failedCount: state.failedCount + 1, windowStartedAt: state.windowStartedAt };

  if (next.failedCount >= MAX_FAILED_ATTEMPTS) {
    return { ...next, lockedUntil: nowSeconds + LOCKOUT_SECONDS };
  }
  return next;
}

/** Reset after a successful login. */
export function clearFailures(): LockoutState {
  return { ...INITIAL_LOCKOUT_STATE };
}

/**
 * Seconds until a lock lifts, or 0 when not locked. Handy for a `Retry-After`
 * hint to the client.
 */
export function retryAfterSeconds(state: LockoutState, nowSeconds: number): number {
  if (!isLockedOut(state, nowSeconds)) {
    return 0;
  }
  return Math.max(0, (state.lockedUntil ?? 0) - nowSeconds);
}
