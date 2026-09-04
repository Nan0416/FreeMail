/**
 * Persistence seam for agent API keys. The service depends on this interface, not on
 * DynamoDB, so the whole mint/list/revoke/verify flow is unit-testable against an in-memory
 * fake. The DynamoDB implementation lives in `ddb-api-keys-dao.ts`.
 */

export interface CreateApiKeyInput {
  /** Public lookup id — the partition key. */
  readonly keyId: string;
  /** SHA-256 (hex) of the secret half. Never the raw secret. */
  readonly secretHash: string;
  /** Optional human label, or null when unnamed. */
  readonly name: string | null;
  /** Creation time, epoch seconds. */
  readonly createdAt: number;
}

export interface CreateApiKeyOutput {
  /**
   * False on a keyId collision (astronomically rare), so the caller can retry with a fresh
   * id rather than silently overwrite an existing key.
   */
  readonly created: boolean;
}

export interface GetApiKeyInput {
  readonly keyId: string;
}

/** One stored key row. The secret itself is never stored, only its hash. */
export interface GetApiKeyOutput {
  readonly keyId: string;
  readonly secretHash: string;
  readonly name: string | null;
  readonly createdAt: number;
}

export interface DeleteApiKeyInput {
  readonly keyId: string;
}

export interface ApiKeysDao {
  /** Store a new key row only if its id is unused. */
  createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyOutput>;

  /** The row for a presented keyId, or null when unknown. */
  getApiKey(input: GetApiKeyInput): Promise<GetApiKeyOutput | null>;

  /** Every key row (single-tenant → a handful; returned unordered). */
  listApiKeys(): Promise<ReadonlyArray<GetApiKeyOutput>>;

  /** Delete a key by id. Idempotent — deleting an unknown id is a no-op. */
  deleteApiKey(input: DeleteApiKeyInput): Promise<void>;
}
