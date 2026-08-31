import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthRepo } from '../../src/data/auth-repo.js';
import { AuthError } from '../../src/auth/errors.js';
import { verifyAccessToken } from '../../src/auth/jwt.js';
import {
  INITIAL_LOCKOUT_STATE,
  MAX_FAILED_ATTEMPTS,
  registerFailure,
} from '../../src/auth/lockout.js';
import type { LockoutState } from '../../src/auth/lockout.js';
import { AuthService, OWNER_SUBJECT } from '../../src/auth/service.js';
import { hashPassword } from '../../src/auth/password.js';

class FakeAuthRepo implements AuthRepo {
  passwordHash: string | null = null;
  lockout: LockoutState | null = null;
  refreshTokens = new Set<string>();
  signingKeyRow: string | null = null;
  /** Runs immediately before the conditional create — models a concurrent enroller. */
  onBeforeCreatePasswordHash?: () => void;

  createPasswordHash(hash: string): Promise<boolean> {
    this.onBeforeCreatePasswordHash?.();
    if (this.passwordHash !== null) {
      return Promise.resolve(false);
    }
    this.passwordHash = hash;
    return Promise.resolve(true);
  }
  getPasswordHash(): Promise<string | null> {
    return Promise.resolve(this.passwordHash);
  }
  getSigningKey(): Promise<string | null> {
    return Promise.resolve(this.signingKeyRow);
  }
  createSigningKey(key: string): Promise<boolean> {
    if (this.signingKeyRow !== null) {
      return Promise.resolve(false);
    }
    this.signingKeyRow = key;
    return Promise.resolve(true);
  }
  getLockout(): Promise<LockoutState | null> {
    return Promise.resolve(this.lockout);
  }
  registerFailedAttempt(nowSeconds: number): Promise<LockoutState> {
    const next = registerFailure(this.lockout ?? INITIAL_LOCKOUT_STATE, nowSeconds);
    this.lockout = next;
    return Promise.resolve(next);
  }
  clearLockout(): Promise<void> {
    this.lockout = null;
    return Promise.resolve();
  }
  putRefreshToken(tokenHash: string): Promise<void> {
    this.refreshTokens.add(tokenHash);
    return Promise.resolve();
  }
  consumeRefreshToken(tokenHash: string): Promise<boolean> {
    return Promise.resolve(this.refreshTokens.delete(tokenHash));
  }
}

const KEY = 'unit-test-signing-key';
const NOW = 1_700_000_000;

let repo: FakeAuthRepo;
let service: AuthService;

beforeEach(() => {
  repo = new FakeAuthRepo();
  service = new AuthService({ repo, signingKey: KEY, now: () => NOW });
});

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<AuthError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected AuthError(${code}) but resolved`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
  return error as AuthError;
}

describe('AuthService.login — trust-on-first-use enrollment', () => {
  const PASSWORD = 'a-strong-enough-password';

  it('enrolls the password and signs in on the first ever login', async () => {
    expect(repo.passwordHash).toBeNull();
    const tokens = await service.login(PASSWORD);
    expect(repo.passwordHash).not.toBeNull();
    const verified = await verifyAccessToken(tokens.accessToken, KEY, NOW);
    expect(verified.valid && verified.claims.sub).toBe(OWNER_SUBJECT);
  });

  it('enrolls exactly once — a later different password is rejected, not re-enrolled', async () => {
    await service.login(PASSWORD);
    const enrolled = repo.passwordHash;
    await expectAuthError(service.login('a-different-password'), 'invalid_credentials');
    expect(repo.passwordHash).toBe(enrolled);
  });

  it('rejects a weak password at enrollment without claiming the account', async () => {
    await expectAuthError(service.login('short'), 'weak_password');
    expect(repo.passwordHash).toBeNull();
  });

  it('still admits an existing password shorter than a later-raised minimum', async () => {
    // Policy is checked only at enrollment, so raising MIN_PASSWORD_LENGTH must not
    // lock an already-enrolled owner out of their own deployment.
    repo.passwordHash = hashPassword('legacy');
    await expect(service.login('legacy')).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('verifies against the winner when a concurrent first login claims the account', async () => {
    // Model the lost race: another caller enrolls between this login's read and write.
    repo.onBeforeCreatePasswordHash = () => {
      repo.passwordHash = hashPassword('winner-password');
    };
    // The loser's own password must not be adopted...
    await expectAuthError(service.login(PASSWORD), 'invalid_credentials');
    // ...and the winner's still works.
    repo.onBeforeCreatePasswordHash = undefined;
    await expect(service.login('winner-password')).resolves.toMatchObject({ tokenType: 'Bearer' });
  });
});

describe('AuthService.login', () => {
  const PASSWORD = 'a-strong-enough-password';

  beforeEach(async () => {
    // The enrolling first login signs in too, so drop its token pair — these tests are
    // about the steady state, where a password is already enrolled.
    await service.login(PASSWORD);
    repo.refreshTokens.clear();
  });

  it('issues a valid token pair on correct credentials', async () => {
    const tokens = await service.login(PASSWORD);
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBeGreaterThan(0);
    expect(repo.refreshTokens.size).toBe(1);

    const verified = await verifyAccessToken(tokens.accessToken, KEY, NOW);
    expect(verified.valid).toBe(true);
    expect(verified.valid && verified.claims.sub).toBe(OWNER_SUBJECT);
  });

  it('counts failures and locks after the threshold', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
      await expectAuthError(service.login('wrong-password'), 'invalid_credentials');
    }
    const locked = await expectAuthError(service.login('wrong-password'), 'account_locked');
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    // Even the correct password is refused while locked.
    await expectAuthError(service.login(PASSWORD), 'account_locked');
  });

  it('clears failure state after a successful login', async () => {
    await expectAuthError(service.login('wrong-password'), 'invalid_credentials');
    await service.login(PASSWORD);
    expect(repo.lockout).toBeNull();
  });
});

describe('AuthService.refresh', () => {
  const PASSWORD = 'a-strong-enough-password';

  beforeEach(async () => {
    await service.login(PASSWORD);
  });

  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const first = await service.login(PASSWORD);
    const second = await service.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // The original refresh token is now spent.
    await expectAuthError(service.refresh(first.refreshToken), 'invalid_token');
    // The rotated one works.
    const third = await service.refresh(second.refreshToken);
    expect(third.accessToken).toBeTruthy();
  });

  it('rejects an unknown refresh token', async () => {
    await expectAuthError(service.refresh('rt_bogus'), 'invalid_token');
  });
});

describe('AuthService.logout', () => {
  it('revokes the refresh token and is idempotent', async () => {
    const tokens = await service.login('a-strong-enough-password');

    await service.logout(tokens.refreshToken);
    expect(repo.refreshTokens.size).toBe(0);
    // Second logout with the same (now unknown) token is a no-op.
    await expect(service.logout(tokens.refreshToken)).resolves.toBeUndefined();
    // And the revoked token can no longer refresh.
    await expectAuthError(service.refresh(tokens.refreshToken), 'invalid_token');
  });
});
