/**
 * Single-tenant auth orchestration: login (which also enrolls on first use),
 * refresh, logout. All I/O goes through the injected `AuthRepo`, and time through
 * the injected clock, so every branch here is unit-testable without AWS.
 */
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  passwordPolicyError,
  type TokenPair,
} from '@freemail/shared';
import type { AuthRepo } from '../data/auth-repo.js';
import { authErrors } from './errors.js';
import { signAccessToken } from './jwt.js';
import { INITIAL_LOCKOUT_STATE, isLockedOut, retryAfterSeconds } from './lockout.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

/** The single subject in a single-tenant deployment. */
export const OWNER_SUBJECT = 'owner';

export interface AuthServiceDeps {
  readonly repo: AuthRepo;
  /** HS256 signing key for access tokens (resolved from the auth table by the caller). */
  readonly signingKey: string;
  /** Epoch-seconds clock; injectable for tests. */
  readonly now?: () => number;
}

export class AuthService {
  private readonly repo: AuthRepo;
  private readonly signingKey: string;
  private readonly now: () => number;

  constructor(deps: AuthServiceDeps) {
    this.repo = deps.repo;
    this.signingKey = deps.signingKey;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Verify the password (subject to lockout) and issue a fresh token pair.
   *
   * On a deployment with no password yet this ENROLLS instead (#42 item 1a,
   * trust-on-first-use): the submitted password is hashed and claimed atomically, and
   * the caller is signed in as the owner. There is no separate set-password step, so
   * whoever reaches this route first owns the account — the same trust boundary the
   * public `POST /auth/set-password` route had, with one fewer step.
   */
  async login(password: string): Promise<TokenPair> {
    const now = this.now();

    const lockout = (await this.repo.getLockout()) ?? INITIAL_LOCKOUT_STATE;
    if (isLockedOut(lockout, now)) {
      throw authErrors.accountLocked(retryAfterSeconds(lockout, now));
    }

    let storedHash = await this.repo.getPasswordHash();
    if (storedHash === null) {
      if (await this.enroll(password)) {
        // Won enrollment. No lockout can have accrued yet — a failed attempt is only
        // recorded below, which requires a stored hash — so there is nothing to clear.
        return this.issueTokens(now);
      }
      // A concurrent first login claimed the account between the read and the write.
      // Fall through and verify against the winner's hash, exactly as a normal login:
      // matching password → signed in, otherwise invalid_credentials.
      storedHash = await this.repo.getPasswordHash();
      if (storedHash === null) {
        throw new Error('Password hash is absent immediately after a lost enrollment race.');
      }
    }

    if (!verifyPassword(password, storedHash)) {
      // Advance the counter atomically so parallel failures can't undercount past
      // the threshold; decide the lock on the committed value.
      const committed = await this.repo.registerFailedAttempt(now);
      if (isLockedOut(committed, now)) {
        throw authErrors.accountLocked(retryAfterSeconds(committed, now));
      }
      throw authErrors.invalidCredentials();
    }

    await this.repo.clearLockout();
    return this.issueTokens(now);
  }

  /**
   * Trust-on-first-use enrollment: claim the account for this password. The atomic
   * conditional write means exactly one concurrent caller can win; the return value
   * tells `login` whether this one did.
   */
  private async enroll(password: string): Promise<boolean> {
    // Policy is enforced here rather than on every login so an existing account with a
    // legacy-length password can still sign in if the minimum is ever raised.
    if (passwordPolicyError(password) !== null) {
      throw authErrors.weakPassword();
    }
    return this.repo.createPasswordHash(hashPassword(password));
  }

  /**
   * Rotate a refresh token: atomically consume the presented one and, only if it
   * existed, issue a new pair. A missing token (unknown, or already rotated) is
   * rejected — so a replayed token buys nothing.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const consumed = await this.repo.consumeRefreshToken(hashRefreshToken(refreshToken));
    if (!consumed) {
      throw authErrors.invalidToken();
    }
    return this.issueTokens(this.now());
  }

  /**
   * Revoke the presented refresh token. Idempotent — an unknown token is a no-op.
   *
   * This invalidates the refresh credential immediately, but the access token is
   * stateless: any already-issued access token stays valid until its short expiry
   * ({@link ACCESS_TOKEN_TTL_SECONDS}). That window is the deliberate trade-off for
   * keeping token verification off the database on the hot path.
   */
  async logout(refreshToken: string): Promise<void> {
    await this.repo.consumeRefreshToken(hashRefreshToken(refreshToken));
  }

  private async issueTokens(now: number): Promise<TokenPair> {
    const accessToken = await signAccessToken(this.signingKey, {
      subject: OWNER_SUBJECT,
      issuedAt: now,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });

    const refreshToken = generateRefreshToken();
    await this.repo.putRefreshToken(
      hashRefreshToken(refreshToken),
      now + REFRESH_TOKEN_TTL_SECONDS,
    );

    return {
      tokenType: 'Bearer',
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
