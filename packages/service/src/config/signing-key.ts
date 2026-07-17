/**
 * Resolve the HS256 signing key from Secrets Manager, cached for the life of the
 * Lambda execution environment. The key is auto-generated at deploy
 * (`generateSecretString`), so there is no manual bootstrap step — reads only.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let client: SecretsManagerClient | undefined;
const cache = new Map<string, string>();

/** Test seam / cold-start reset — clears the cached key. */
export function resetSigningKeyCache(): void {
  cache.clear();
  client = undefined;
}

export async function getSigningKey(secretId = process.env.SIGNING_KEY_SECRET_ID): Promise<string> {
  if (!secretId) {
    throw new Error('SIGNING_KEY_SECRET_ID is not set.');
  }
  const cached = cache.get(secretId);
  if (cached) {
    return cached;
  }

  client ??= new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = result.SecretString;
  if (!value) {
    throw new Error(`Signing-key secret ${secretId} has no string value.`);
  }
  cache.set(secretId, value);
  return value;
}
