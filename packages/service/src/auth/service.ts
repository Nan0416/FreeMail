/**
 * Single-tenant auth orchestration: set-password (first run), login, refresh,
 * logout. All I/O goes through the injected `AuthRepo`, and time through the
 * injected clock, so every branch here is unit-testable without AWS.
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
import {
  INITIAL_LOCKOUT_STATE,
  isLockedOut,
  registerFailure,
  retryAfterSeconds,
} from './lockout.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

/** The single subject in a single-tenant deployment. */
export const OWNER_SUBJECT = 'owner';

export interface AuthServiceDeps {
  repo: AuthRepo;
  /** HS256 signing key for access tokens (resolved from Secrets Manager by the caller). */
  signingKey: string;
  /** Epoch-seconds clock; injectable for tests. */
  now?: () => number;
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

  /** First-run only: set the account password. Rejects if one is already set. */
  async setPassword(password: string): Promise<void> {
    if (passwordPolicyError(password) !== null) {
      throw authErrors.weakPassword();
    }
    const created = await this.repo.createPasswordHash(hashPassword(password));
    if (!created) {
      throw authErrors.passwordAlreadySet();
    }
  }

  /** Verify the password (subject to lockout) and issue a fresh token pair. */
  async login(password: string): Promise<TokenPair> {
    const now = this.now();

    const lockout = (await this.repo.getLockout()) ?? INITIAL_LOCKOUT_STATE;
    if (isLockedOut(lockout, now)) {
      throw authErrors.accountLocked(retryAfterSeconds(lockout, now));
    }

    const storedHash = await this.repo.getPasswordHash();
    if (storedHash === null) {
      throw authErrors.passwordNotSet();
    }

    if (!verifyPassword(password, storedHash)) {
      const next = registerFailure(lockout, now);
      await this.repo.putLockout(next, now + REFRESH_TOKEN_TTL_SECONDS);
      if (isLockedOut(next, now)) {
        throw authErrors.accountLocked(retryAfterSeconds(next, now));
      }
      throw authErrors.invalidCredentials();
    }

    await this.repo.clearLockout();
    return this.issueTokens(now);
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

  /** Revoke the presented refresh token. Idempotent — an unknown token is a no-op. */
  async logout(refreshToken: string): Promise<void> {
    await this.repo.consumeRefreshToken(hashRefreshToken(refreshToken));
  }

  private async issueTokens(now: number): Promise<TokenPair> {
    const accessToken = signAccessToken(this.signingKey, {
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
