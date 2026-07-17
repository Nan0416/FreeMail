import type { LockoutState } from '../auth/lockout.js';

/**
 * Persistence seam for auth. The service depends on this interface, not on
 * DynamoDB, so the whole login/refresh/lockout flow is unit-testable against an
 * in-memory fake. The DynamoDB implementation lives in `ddb-auth-repo.ts`.
 */
export interface AuthRepo {
  /**
   * Store the password hash only if none exists yet (first-run). Returns false
   * when a password was already set, so the caller can reject re-setting without
   * a separate read.
   */
  createPasswordHash(hash: string): Promise<boolean>;

  /** The stored password hash, or null when set-password has not run. */
  getPasswordHash(): Promise<string | null>;

  /**
   * Current lockout counters (or null when there have been no recent failures),
   * for the pre-verify fast reject. A slightly stale read here is safe — it only
   * gates whether to attempt the password check; the authoritative count is
   * advanced atomically by {@link registerFailedAttempt}.
   */
  getLockout(): Promise<LockoutState | null>;

  /**
   * Atomically fold one failed attempt into the lockout state and return the
   * committed result. Must be lost-update-free under concurrent failures (so the
   * threshold can't be bypassed by parallelizing attempts) — the DynamoDB
   * implementation does a versioned compare-and-swap retry.
   */
  registerFailedAttempt(nowSeconds: number): Promise<LockoutState>;

  /**
   * Reset lockout counters after a successful login. Must ADVANCE the same version
   * the failed-attempt CAS uses (not merely delete), so an in-flight failure that
   * read the pre-reset state cannot land afterward and resurrect a stale count.
   */
  clearLockout(): Promise<void>;

  /** Persist a refresh token by its hash, expiring at `ttlEpochSeconds` (DynamoDB TTL). */
  putRefreshToken(tokenHash: string, ttlEpochSeconds: number): Promise<void>;

  /**
   * Atomically consume a refresh token: delete it and report whether it existed.
   * A false return means the token was unknown or already used — the signal that
   * drives rotation (a rotated token can't be replayed).
   */
  consumeRefreshToken(tokenHash: string): Promise<boolean>;
}
