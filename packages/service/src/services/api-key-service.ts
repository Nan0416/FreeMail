/**
 * API-key orchestration: create (shown once), list (summaries only), revoke, and
 * verify (for the Lambda authorizer). All I/O goes through the injected
 * {@link ApiKeysDao} and time through the injected clock, so every branch is
 * unit-testable without AWS.
 */
import {
  MAX_API_KEY_NAME_LENGTH,
  type ApiKeySummary,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
} from '@freemail/shared';
import { authErrors } from '../utils/errors.js';
import type { ApiKeysDao, GetApiKeyOutput } from '../data/api-keys-dao.js';
import { generateApiKey, parseApiKey, verifyApiKeySecret } from '../utils/api-key.js';

/** keyId collisions are astronomically unlikely; retry a few times rather than trust one draw. */
const MAX_CREATE_ATTEMPTS = 5;

export interface ApiKeyServiceDeps {
  readonly apiKeysDao: ApiKeysDao;
  /** Epoch-seconds clock; injectable for tests. */
  readonly now?: () => number;
}

export interface CreateApiKeyServiceRequest {
  /** Optional human label. Trimmed; blank becomes null. */
  readonly name?: string | undefined;
}

/**
 * No inputs: a single-tenant deployment lists its whole (small) key set. Modelled as a
 * Request anyway so every service method reads the same way, and so a filter or a page
 * cursor can be added later without changing a signature. Expressed as a type alias rather
 * than an empty interface, which the lint config rejects for being assignable from anything.
 */
export type ListApiKeysServiceRequest = Record<string, never>;

export interface RevokeApiKeyServiceRequest {
  readonly keyId: string;
}

export interface VerifyApiKeyServiceRequest {
  /** The raw presented key. Never logged, never stored. */
  readonly rawKey: string;
}

export interface VerifyApiKeyServiceResponse {
  /** The public id of the key that matched. */
  readonly keyId: string;
}

export class ApiKeyService {
  private readonly apiKeysDao: ApiKeysDao;
  private readonly now: () => number;

  constructor(deps: ApiKeyServiceDeps) {
    this.apiKeysDao = deps.apiKeysDao;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Mint a new key. The raw key is in the response exactly once; only its hash is stored. */
  async createApiKey(request: CreateApiKeyServiceRequest): Promise<CreateApiKeyResponse> {
    const label = this.normalizeName(request.name);
    const createdAt = this.now();
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const generated = generateApiKey();
      const result = await this.apiKeysDao.createApiKey({
        keyId: generated.keyId,
        secretHash: generated.secretHash,
        name: label,
        createdAt,
      });
      if (result.created) {
        return {
          ...toSummary({ keyId: generated.keyId, name: label, createdAt }),
          key: generated.key,
        };
      }
    }
    throw new Error('Failed to allocate a unique API key id.');
  }

  /** All keys as summaries (newest first), never exposing the secret. */
  async listApiKeys(_request: ListApiKeysServiceRequest): Promise<ListApiKeysResponse> {
    const result = await this.apiKeysDao.listApiKeys({});
    return { keys: [...result.apiKeys].sort((a, b) => b.createdAt - a.createdAt).map(toSummary) };
  }

  /** Revoke a key by id. Idempotent — revoking an unknown/already-revoked id is a no-op. */
  async revokeApiKey(request: RevokeApiKeyServiceRequest): Promise<void> {
    await this.apiKeysDao.deleteApiKey({ keyId: request.keyId });
  }

  /**
   * Validate a presented raw key. Returns the keyId on success, or null when the
   * key is malformed, unknown, or its secret does not match. Lookup by the public
   * keyId, then a constant-time secret comparison.
   */
  async verifyApiKey(
    request: VerifyApiKeyServiceRequest,
  ): Promise<VerifyApiKeyServiceResponse | null> {
    const parsed = parseApiKey(request.rawKey);
    if (!parsed) {
      return null;
    }
    const record = await this.apiKeysDao.getApiKey({ keyId: parsed.keyId });
    if (!record) {
      return null;
    }
    return verifyApiKeySecret(parsed.secret, record.secretHash) ? { keyId: record.keyId } : null;
  }

  private normalizeName(name: string | undefined): string | null {
    if (name === undefined) {
      return null;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MAX_API_KEY_NAME_LENGTH) {
      throw authErrors.invalidRequest(
        `"name" must be at most ${MAX_API_KEY_NAME_LENGTH} characters.`,
      );
    }
    return trimmed;
  }
}

function toSummary(record: Pick<GetApiKeyOutput, 'keyId' | 'name' | 'createdAt'>): ApiKeySummary {
  return {
    id: record.keyId,
    name: record.name,
    createdAt: new Date(record.createdAt * 1000).toISOString(),
  };
}
