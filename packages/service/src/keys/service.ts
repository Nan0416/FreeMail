/**
 * API-key orchestration: create (shown once), list (summaries only), revoke, and
 * verify (for the Lambda authorizer). All I/O goes through the injected
 * {@link ApiKeysRepo} and time through the injected clock, so every branch is
 * unit-testable without AWS.
 */
import {
  MAX_API_KEY_NAME_LENGTH,
  type ApiKeySummary,
  type CreateApiKeyResponse,
} from '@freemail/shared';
import { authErrors } from '../auth/errors.js';
import type { ApiKeyRecord, ApiKeysRepo } from '../data/keys-repo.js';
import { generateApiKey, parseApiKey, verifyApiKeySecret } from './api-key.js';

/** keyId collisions are astronomically unlikely; retry a few times rather than trust one draw. */
const MAX_CREATE_ATTEMPTS = 5;

export interface ApiKeyServiceDeps {
  repo: ApiKeysRepo;
  /** Epoch-seconds clock; injectable for tests. */
  now?: () => number;
}

export class ApiKeyService {
  private readonly repo: ApiKeysRepo;
  private readonly now: () => number;

  constructor(deps: ApiKeyServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Mint a new key. The raw key is in the response exactly once; only its hash is stored. */
  async create(name?: string): Promise<CreateApiKeyResponse> {
    const label = this.normalizeName(name);
    const createdAt = this.now();
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const generated = generateApiKey();
      const stored = await this.repo.create({
        keyId: generated.keyId,
        secretHash: generated.secretHash,
        name: label,
        createdAt,
      });
      if (stored) {
        return {
          ...toSummary({ keyId: generated.keyId, name: label, createdAt }),
          key: generated.key,
        };
      }
    }
    throw new Error('Failed to allocate a unique API key id.');
  }

  /** All keys as summaries (newest first), never exposing the secret. */
  async list(): Promise<ApiKeySummary[]> {
    const records = await this.repo.list();
    return records.sort((a, b) => b.createdAt - a.createdAt).map(toSummary);
  }

  /** Revoke a key by id. Idempotent — revoking an unknown/already-revoked id is a no-op. */
  async revoke(keyId: string): Promise<void> {
    await this.repo.delete(keyId);
  }

  /**
   * Validate a presented raw key. Returns the keyId on success, or null when the
   * key is malformed, unknown, or its secret does not match. Lookup by the public
   * keyId, then a constant-time secret comparison.
   */
  async verify(rawKey: string): Promise<string | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) {
      return null;
    }
    const record = await this.repo.getByKeyId(parsed.keyId);
    if (!record) {
      return null;
    }
    return verifyApiKeySecret(parsed.secret, record.secretHash) ? record.keyId : null;
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

function toSummary(record: Pick<ApiKeyRecord, 'keyId' | 'name' | 'createdAt'>): ApiKeySummary {
  return {
    id: record.keyId,
    name: record.name,
    createdAt: new Date(record.createdAt * 1000).toISOString(),
  };
}
