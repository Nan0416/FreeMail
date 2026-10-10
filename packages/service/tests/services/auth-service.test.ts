import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AuthDao,
  ClearLockoutOutput,
  ConsumeRefreshTokenInput,
  ConsumeRefreshTokenOutput,
  CreatePasswordHashInput,
  CreatePasswordHashOutput,
  CreateSigningKeyInput,
  CreateSigningKeyOutput,
  GetLockoutOutput,
  GetPasswordHashOutput,
  GetSigningKeyOutput,
  PutRefreshTokenInput,
  PutRefreshTokenOutput,
  RegisterFailedAttemptInput,
  RegisterFailedAttemptOutput,
} from '../../src/data/auth-dao.js';
import { AuthError } from '../../src/utils/errors.js';
import { verifyAccessToken } from '../../src/utils/jwt.js';
import {
  INITIAL_LOCKOUT_STATE,
  MAX_FAILED_ATTEMPTS,
  registerFailure,
} from '../../src/utils/lockout.js';
import type { LockoutState } from '../../src/utils/lockout.js';
import { AuthService, OWNER_SUBJECT } from '../../src/services/auth-service.js';
import { StaticSigningKeyProvider } from '../../src/facades/signing-key-provider.js';
import { hashPassword } from '../../src/utils/password.js';

class FakeAuthDao implements AuthDao {
  passwordHash: string | null = null;
  lockout: LockoutState | null = null;
  refreshTokens = new Set<string>();
  signingKeyRow: string | null = null;
  /** Runs immediately before the conditional create — models a concurrent enroller. */
  onBeforeCreatePasswordHash?: () => void;

  createPasswordHash(input: CreatePasswordHashInput): Promise<CreatePasswordHashOutput> {
    this.onBeforeCreatePasswordHash?.();
    if (this.passwordHash !== null) {
      return Promise.resolve({ created: false });
    }
    this.passwordHash = input.hash;
    return Promise.resolve({ created: true });
  }
  getPasswordHash(): Promise<GetPasswordHashOutput | null> {
    return Promise.resolve(this.passwordHash === null ? null : { hash: this.passwordHash });
  }
  getSigningKey(): Promise<GetSigningKeyOutput | null> {
    return Promise.resolve(this.signingKeyRow === null ? null : { key: this.signingKeyRow });
  }
  createSigningKey(input: CreateSigningKeyInput): Promise<CreateSigningKeyOutput> {
    if (this.signingKeyRow !== null) {
      return Promise.resolve({ created: false });
    }
    this.signingKeyRow = input.key;
    return Promise.resolve({ created: true });
  }
  getLockout(): Promise<GetLockoutOutput | null> {
    return Promise.resolve(this.lockout);
  }
  registerFailedAttempt(input: RegisterFailedAttemptInput): Promise<RegisterFailedAttemptOutput> {
    const next = registerFailure(this.lockout ?? INITIAL_LOCKOUT_STATE, input.nowSeconds);
    this.lockout = next;
    return Promise.resolve(next);
  }
  clearLockout(): Promise<ClearLockoutOutput> {
    this.lockout = null;
    return Promise.resolve({});
  }
  putRefreshToken(input: PutRefreshTokenInput): Promise<PutRefreshTokenOutput> {
    this.refreshTokens.add(input.tokenHash);
    return Promise.resolve({});
  }
  consumeRefreshToken(input: ConsumeRefreshTokenInput): Promise<ConsumeRefreshTokenOutput> {
    return Promise.resolve({ consumed: this.refreshTokens.delete(input.tokenHash) });
  }
}

const KEY = 'unit-test-signing-key';
const NOW = 1_700_000_000;

let repo: FakeAuthDao;
let service: AuthService;

beforeEach(() => {
  repo = new FakeAuthDao();
  service = new AuthService({
    authDao: repo,
    signingKey: new StaticSigningKeyProvider(KEY),
    now: () => NOW,
  });
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
    const tokens = await service.login({ password: PASSWORD });
    expect(repo.passwordHash).not.toBeNull();
    const verified = await verifyAccessToken(tokens.accessToken, KEY, NOW);
    expect(verified.valid && verified.claims.sub).toBe(OWNER_SUBJECT);
  });

  it('enrolls exactly once — a later different password is rejected, not re-enrolled', async () => {
    await service.login({ password: PASSWORD });
    const enrolled = repo.passwordHash;
    await expectAuthError(
      service.login({ password: 'a-different-password' }),
      'invalid_credentials',
    );
    expect(repo.passwordHash).toBe(enrolled);
  });

  it('rejects a weak password at enrollment without claiming the account', async () => {
    await expectAuthError(service.login({ password: 'short' }), 'weak_password');
    expect(repo.passwordHash).toBeNull();
  });

  it('still admits an existing password shorter than a later-raised minimum', async () => {
    // Policy is checked only at enrollment, so raising MIN_PASSWORD_LENGTH must not
    // lock an already-enrolled owner out of their own deployment.
    repo.passwordHash = hashPassword('legacy');
    await expect(service.login({ password: 'legacy' })).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
  });

  it('verifies against the winner when a concurrent first login claims the account', async () => {
    // Model the lost race: another caller enrolls between this login's read and write.
    repo.onBeforeCreatePasswordHash = () => {
      repo.passwordHash = hashPassword('winner-password');
    };
    // The loser's own password must not be adopted...
    await expectAuthError(service.login({ password: PASSWORD }), 'invalid_credentials');
    // ...and the winner's still works.
    repo.onBeforeCreatePasswordHash = undefined;
    await expect(service.login({ password: 'winner-password' })).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
  });
});

describe('AuthService.login', () => {
  const PASSWORD = 'a-strong-enough-password';

  beforeEach(async () => {
    // The enrolling first login signs in too, so drop its token pair — these tests are
    // about the steady state, where a password is already enrolled.
    await service.login({ password: PASSWORD });
    repo.refreshTokens.clear();
  });

  it('issues a valid token pair on correct credentials', async () => {
    const tokens = await service.login({ password: PASSWORD });
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBeGreaterThan(0);
    expect(repo.refreshTokens.size).toBe(1);

    const verified = await verifyAccessToken(tokens.accessToken, KEY, NOW);
    expect(verified.valid).toBe(true);
    expect(verified.valid && verified.claims.sub).toBe(OWNER_SUBJECT);
  });

  it('counts failures and locks after the threshold', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
      await expectAuthError(service.login({ password: 'wrong-password' }), 'invalid_credentials');
    }
    const locked = await expectAuthError(
      service.login({ password: 'wrong-password' }),
      'account_locked',
    );
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    // Even the correct password is refused while locked.
    await expectAuthError(service.login({ password: PASSWORD }), 'account_locked');
  });

  it('clears failure state after a successful login', async () => {
    await expectAuthError(service.login({ password: 'wrong-password' }), 'invalid_credentials');
    await service.login({ password: PASSWORD });
    expect(repo.lockout).toBeNull();
  });
});

describe('AuthService.refresh', () => {
  const PASSWORD = 'a-strong-enough-password';

  beforeEach(async () => {
    await service.login({ password: PASSWORD });
  });

  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const first = await service.login({ password: PASSWORD });
    const second = await service.refresh({ refreshToken: first.refreshToken });
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // The original refresh token is now spent.
    await expectAuthError(service.refresh({ refreshToken: first.refreshToken }), 'invalid_token');
    // The rotated one works.
    const third = await service.refresh({ refreshToken: second.refreshToken });
    expect(third.accessToken).toBeTruthy();
  });

  it('rejects an unknown refresh token', async () => {
    await expectAuthError(service.refresh({ refreshToken: 'rt_bogus' }), 'invalid_token');
  });
});

describe('AuthService.logout', () => {
  it('revokes the refresh token and is idempotent', async () => {
    const tokens = await service.login({ password: 'a-strong-enough-password' });

    await service.logout({ refreshToken: tokens.refreshToken });
    expect(repo.refreshTokens.size).toBe(0);
    // Second logout with the same (now unknown) token is a no-op.
    await expect(service.logout({ refreshToken: tokens.refreshToken })).resolves.toBeUndefined();
    // And the revoked token can no longer refresh.
    await expectAuthError(service.refresh({ refreshToken: tokens.refreshToken }), 'invalid_token');
  });
});
