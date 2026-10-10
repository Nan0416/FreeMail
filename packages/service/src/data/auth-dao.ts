/**
 * Persistence seam for auth. The service depends on this interface, not on DynamoDB, so the
 * whole login/refresh/lockout flow is unit-testable against an in-memory fake. The DynamoDB
 * implementation lives in `ddb-auth-dao.ts`.
 *
 * Every method takes a named `Input` and returns a named `Output` (or `Output | null`) —
 * empty ones when there is nothing to pass or report — so a caller never passes two bare
 * positional values that could be transposed, and every signature can grow in one place.
 *
 * The `created` / `consumed` booleans are not conveniences — each is the observable result
 * of a DynamoDB `ConditionExpression`, and the caller's correctness depends on it. They are
 * wrapped in Output interfaces so the meaning travels with the value.
 */
import type { LockoutState } from '../utils/lockout.js';

// --- Password ---

export interface CreatePasswordHashInput {
  /** scrypt hash of the enrolled password. The raw password is never stored. */
  readonly hash: string;
}

export interface CreatePasswordHashOutput {
  /**
   * False when a password was already enrolled, so the conditional write did not run.
   * This is the trust-on-first-use gate: exactly one concurrent caller can see `true`.
   */
  readonly created: boolean;
}

export interface GetPasswordHashInput {}

export interface GetPasswordHashOutput {
  readonly hash: string;
}

// --- Signing key ---

export interface CreateSigningKeyInput {
  readonly key: string;
}

export interface CreateSigningKeyOutput {
  /**
   * False when a concurrent cold start won the race. The caller must then adopt the
   * winner's key rather than sign tokens with one no other instance would accept.
   */
  readonly created: boolean;
}

export interface GetSigningKeyInput {}

export interface GetSigningKeyOutput {
  readonly key: string;
}

// --- Lockout ---

export interface GetLockoutInput {}

/** Current lockout counters. Shaped by the policy in `utils/lockout.ts`, which owns them. */
export interface GetLockoutOutput extends LockoutState {}

export interface RegisterFailedAttemptInput {
  /** Server clock, epoch seconds — decides whether the failure window has rolled over. */
  readonly nowSeconds: number;
}

/** The committed counters after folding in one failure. */
export interface RegisterFailedAttemptOutput extends LockoutState {}

export interface ClearLockoutInput {}

export interface ClearLockoutOutput {}

// --- Refresh tokens ---

export interface PutRefreshTokenInput {
  /** SHA-256 of the refresh token. The raw token is never stored. */
  readonly tokenHash: string;
  /** DynamoDB TTL, epoch seconds. */
  readonly ttlEpochSeconds: number;
}

export interface PutRefreshTokenOutput {}

export interface ConsumeRefreshTokenInput {
  readonly tokenHash: string;
}

export interface ConsumeRefreshTokenOutput {
  /**
   * False when the token was unknown or already used. This is what makes rotation safe:
   * a rotated token cannot be replayed, because only one delete can observe `true`.
   */
  readonly consumed: boolean;
}

export interface AuthDao {
  /** Store the password hash only if none exists yet (first run). */
  createPasswordHash(input: CreatePasswordHashInput): Promise<CreatePasswordHashOutput>;

  /** The stored password hash, or null when no password has been enrolled yet. */
  getPasswordHash(input: GetPasswordHashInput): Promise<GetPasswordHashOutput | null>;

  /**
   * The persisted HS256 access-token signing key, or null when none has been generated yet.
   * Read by both the token writer and the authorizer, which fails closed on null (no key can
   * have signed a token that does not exist yet).
   */
  getSigningKey(input: GetSigningKeyInput): Promise<GetSigningKeyOutput | null>;

  /** Store the signing key only if none exists yet. */
  createSigningKey(input: CreateSigningKeyInput): Promise<CreateSigningKeyOutput>;

  /**
   * Current lockout counters (or null when there have been no recent failures), for the
   * pre-verify fast reject. A slightly stale read is safe — it only gates whether to attempt
   * the password check; the authoritative count is advanced by {@link registerFailedAttempt}.
   */
  getLockout(input: GetLockoutInput): Promise<GetLockoutOutput | null>;

  /**
   * Atomically fold one failed attempt into the lockout state and return the committed
   * result. Must be lost-update-free under concurrent failures (so the threshold cannot be
   * bypassed by parallelizing attempts) — the DynamoDB implementation does a versioned
   * compare-and-swap retry.
   */
  registerFailedAttempt(input: RegisterFailedAttemptInput): Promise<RegisterFailedAttemptOutput>;

  /**
   * Reset lockout counters after a successful login. Must ADVANCE the same version the
   * failed-attempt CAS uses (not merely delete), so an in-flight failure that read the
   * pre-reset state cannot land afterward and resurrect a stale count.
   */
  clearLockout(input: ClearLockoutInput): Promise<ClearLockoutOutput>;

  /** Persist a refresh token by its hash, expiring at `ttlEpochSeconds` (DynamoDB TTL). */
  putRefreshToken(input: PutRefreshTokenInput): Promise<PutRefreshTokenOutput>;

  /** Atomically consume a refresh token: delete it and report whether it existed. */
  consumeRefreshToken(input: ConsumeRefreshTokenInput): Promise<ConsumeRefreshTokenOutput>;
}
