/**
 * Lazy access to the HS256 signing key, mirroring conduit's `SecretProvider` facade.
 *
 * `AuthService` needs the key only when it actually mints a token, but resolving it is I/O:
 * a DynamoDB read, and on a virgin deployment a conditional write to claim a generated key.
 * Injecting a PROVIDER rather than a resolved string is what lets the dependency factory
 * stay eager and synchronous — conduit's shape — while keeping that I/O off the cold-start
 * path. Two consequences that matter:
 *
 *  - the #47 Layer 3 media-type gate still runs before anything touches the auth table, so
 *    "a wrongly-shaped request changes nothing" stays literally true; and
 *  - the public `GET /d/{token}` route never reads the auth table at all.
 *
 * The read-through cache lives in `config/signing-key.ts`, which also owns the create-race
 * handling (racing cold starts converge on one key rather than signing tokens the others
 * would reject). This is the injection seam over that logic, not a second copy of it.
 */
import type { AuthDao } from '../data/auth-dao.js';
import { getOrCreateSigningKey } from '../utils/signing-key.js';

export interface SigningKeyProvider {
  get(): Promise<string>;
}

/**
 * The writer path, for the REST handler — the only component holding a write grant on the
 * auth table. Returns the persisted key, generating and claiming one on first use.
 */
export class DdbSigningKeyProvider implements SigningKeyProvider {
  private readonly authDao: AuthDao;

  constructor(authDao: AuthDao) {
    this.authDao = authDao;
  }

  get(): Promise<string> {
    return getOrCreateSigningKey(this.authDao);
  }
}

/** A fixed key. For tests and for any caller that already holds the resolved value. */
export class StaticSigningKeyProvider implements SigningKeyProvider {
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  get(): Promise<string> {
    return Promise.resolve(this.key);
  }
}
