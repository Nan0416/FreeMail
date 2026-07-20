/**
 * Wire contract for agent API keys, shared by the service (which mints and
 * validates them) and the React app / CLI (which manage them). An API key is the
 * single credential an agent presents to the MCP server; one key grants full
 * access — there are no per-key scopes in v1.
 *
 * The raw key is `fm_<keyId>_<secret>`: `keyId` is a public lookup id (it keys the
 * stored row and is what the management list shows), while `secret` is the
 * high-entropy half stored only as a hash and shown in full exactly once, at
 * creation. You cannot hash-then-look-up a bare random string, so the public
 * `keyId` is what makes the stored-hashed scheme retrievable.
 */

/** Prefix on every raw key — makes a leaked key obviously a FreeMail credential (GitHub-PAT style). */
export const API_KEY_PREFIX = 'fm_';

/** Upper bound on the optional human label. Enforced server-side; the app pre-checks with the same value. */
export const MAX_API_KEY_NAME_LENGTH = 100;

/** A key as shown in the management list — deliberately never includes the secret. */
export interface ApiKeySummary {
  /** Public key id (the `keyId` half of the raw key). Stable and safe to display. */
  readonly id: string;
  /** Optional human label, or null when the key was created unnamed. */
  readonly name: string | null;
  /** Creation time, ISO-8601. */
  readonly createdAt: string;
}

export interface CreateApiKeyRequest {
  /** Optional label so keys can be told apart in the UI. */
  readonly name?: string;
}

/** Creation response: the summary plus the raw key, returned only this once. */
export interface CreateApiKeyResponse extends ApiKeySummary {
  /** The full `fm_<keyId>_<secret>` key. Shown once — it is never retrievable again. */
  readonly key: string;
}

export interface ListApiKeysResponse {
  readonly keys: readonly ApiKeySummary[];
}
