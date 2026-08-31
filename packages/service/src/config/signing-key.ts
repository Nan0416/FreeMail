/**
 * Resolve the HS256 signing key from the auth table (#42 item 1b — FreeMail has no
 * Secrets Manager dependency), cached for the life of the Lambda execution environment.
 *
 * The key is generated lazily on first use rather than at deploy, so `cdk deploy` still
 * needs no out-of-band secret. Generation is a conditional write, so racing cold starts
 * converge on exactly one key: the loser adopts the winner's rather than signing tokens
 * no other instance would accept. Nothing is ever signed before the persisted value
 * resolves, and `authTable` is RETAIN, so the key survives redeploys — a rotated key
 * would invalidate every outstanding token.
 */
import { randomBytes } from 'node:crypto';
import type { AuthRepo } from '../data/auth-repo.js';

/** 32 bytes of entropy — well past the 256-bit HS256 block size. */
const SIGNING_KEY_BYTES = 32;

let cache: string | undefined;

/** Test seam / cold-start reset — clears the cached key. */
export function resetSigningKeyCache(): void {
  cache = undefined;
}

/**
 * Writer path (REST handler, which owns `authTable` read-write): return the persisted
 * key, generating and claiming one on first use.
 */
export async function getOrCreateSigningKey(repo: AuthRepo): Promise<string> {
  if (cache !== undefined) {
    return cache;
  }

  const existing = await repo.getSigningKey();
  if (existing !== null) {
    cache = existing;
    return existing;
  }

  const generated = randomBytes(SIGNING_KEY_BYTES).toString('base64url');
  if (await repo.createSigningKey(generated)) {
    cache = generated;
    return generated;
  }

  // Lost the create race to a concurrent cold start — adopt the winner's key, which is
  // the one the authorizer will verify against.
  const winner = await repo.getSigningKey();
  if (winner === null) {
    throw new Error('Signing key is absent immediately after a lost create race.');
  }
  cache = winner;
  return winner;
}

/**
 * Reader path (Lambda authorizer, which holds `authTable` read only): the persisted key,
 * or null when none has been generated. Null is safe to fail closed on — the key is
 * created by the login route before any access token can exist, so a token presented
 * against an empty table cannot be one this deployment issued.
 */
export async function getSigningKey(repo: AuthRepo): Promise<string | null> {
  if (cache !== undefined) {
    return cache;
  }
  const existing = await repo.getSigningKey();
  if (existing !== null) {
    cache = existing;
  }
  return existing;
}
