/**
 * Persistence seam for API keys. The service depends on this interface, not on
 * DynamoDB, so the whole mint/list/revoke/verify flow is unit-testable against an
 * in-memory fake. The DynamoDB implementation lives in `ddb-keys-repo.ts`.
 */
export interface ApiKeyRecord {
  /** Public lookup id — the partition key. */
  keyId: string;
  /** SHA-256 (hex) of the secret half. Never the raw secret. */
  secretHash: string;
  /** Optional human label, or null when unnamed. */
  name: string | null;
  /** Creation time, epoch seconds. */
  createdAt: number;
}

export interface ApiKeysRepo {
  /**
   * Store a new key row only if its id is unused. Returns false on a keyId
   * collision (astronomically rare) so the caller can retry with a fresh id
   * rather than silently overwrite an existing key.
   */
  create(record: ApiKeyRecord): Promise<boolean>;

  /** The row for a presented keyId, or null when unknown. */
  getByKeyId(keyId: string): Promise<ApiKeyRecord | null>;

  /** Every key row (single-tenant → a handful; returned unordered). */
  list(): Promise<ApiKeyRecord[]>;

  /** Delete a key by id. Idempotent — deleting an unknown id is a no-op. */
  delete(keyId: string): Promise<void>;
}
