import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthRepo } from '../data/auth-repo.js';
import { AuthError } from './errors.js';
import { verifyAccessToken } from './jwt.js';
import { MAX_FAILED_ATTEMPTS } from './lockout.js';
import type { LockoutState } from './lockout.js';
import { AuthService, OWNER_SUBJECT } from './service.js';

class FakeAuthRepo implements AuthRepo {
  passwordHash: string | null = null;
  lockout: LockoutState | null = null;
  refreshTokens = new Set<string>();

  createPasswordHash(hash: string): Promise<boolean> {
    if (this.passwordHash !== null) {
      return Promise.resolve(false);
    }
    this.passwordHash = hash;
    return Promise.resolve(true);
  }
  getPasswordHash(): Promise<string | null> {
    return Promise.resolve(this.passwordHash);
  }
  getLockout(): Promise<LockoutState | null> {
    return Promise.resolve(this.lockout);
  }
  putLockout(state: LockoutState): Promise<void> {
    this.lockout = state;
    return Promise.resolve();
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

describe('AuthService.setPassword', () => {
  it('rejects a weak password', async () => {
    await expectAuthError(service.setPassword('short'), 'weak_password');
    expect(repo.passwordHash).toBeNull();
  });

  it('sets the password on first run and rejects a second set', async () => {
    await service.setPassword('a-strong-enough-password');
    expect(repo.passwordHash).not.toBeNull();
    await expectAuthError(service.setPassword('another-strong-password'), 'password_already_set');
  });
});

describe('AuthService.login', () => {
  const PASSWORD = 'a-strong-enough-password';

  beforeEach(async () => {
    await service.setPassword(PASSWORD);
  });

  it('rejects login before a password is set', async () => {
    const fresh = new AuthService({ repo: new FakeAuthRepo(), signingKey: KEY, now: () => NOW });
    await expectAuthError(fresh.login(PASSWORD), 'password_not_set');
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
    await service.setPassword(PASSWORD);
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
    await service.setPassword('a-strong-enough-password');
    const tokens = await service.login('a-strong-enough-password');

    await service.logout(tokens.refreshToken);
    expect(repo.refreshTokens.size).toBe(0);
    // Second logout with the same (now unknown) token is a no-op.
    await expect(service.logout(tokens.refreshToken)).resolves.toBeUndefined();
    // And the revoked token can no longer refresh.
    await expectAuthError(service.refresh(tokens.refreshToken), 'invalid_token');
  });
});
