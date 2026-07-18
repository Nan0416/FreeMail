/**
 * Persistence seam for outbound large-attachment download tokens (#14). The
 * download service depends on this interface, not on DynamoDB, so the token
 * lifecycle (mint on send, claim on `GET /d/{token}`) is unit-testable against an
 * in-memory fake. The DynamoDB implementation lives in `ddb-download-tokens-repo.ts`.
 *
 * A token is the SOLE capability for an unauthenticated download, so the record's
 * `s3Key` is server-side only and never leaves the backend — the read path 302s to
 * a freshly minted presigned GET, so the bucket/key are never disclosed to a client.
 */

/** One download token — the capability for one uploaded outbound attachment. */
export interface DownloadTokenRecord {
  /** High-entropy random token (the partition key). The capability itself. */
  token: string;
  /** Server-side S3 pointer to the uploaded attachment. NEVER returned to a client. */
  s3Key: string;
  /** Original filename, for the download's `Content-Disposition`. */
  filename: string;
  /** Stored content type — metadata only; the download is always served as an octet-stream. */
  contentType: string;
  sizeBytes: number;
  /** FreeMail id of the sent message this attachment belongs to (correlation). */
  emailId: string;
  /** Mint time, ISO-8601 UTC. */
  createdAt: string;
  /**
   * Server-authoritative expiry, ISO-8601 UTC. Enforced on every claim (a claim past
   * this instant fails closed). DynamoDB TTL (`ttl`) only garbage-collects the row later.
   */
  expiresAt: string;
  /** DynamoDB TTL attribute (epoch seconds = `expiresAt`). Best-effort cleanup, not the gate. */
  ttl: number;
  /** Revoked tokens fail closed on claim (the revoke endpoint/UI is #35). */
  revoked: boolean;
  /** How many times the token has been successfully claimed. */
  downloadCount: number;
  /** Optional cap; when set, a claim past the cap fails closed. Multi-use (unlimited) when absent. */
  maxDownloads?: number;
}

export interface DownloadTokensRepo {
  /**
   * Store a new token row. Conditional on the token not already existing, so a
   * (astronomically unlikely) token collision can never clobber an existing row.
   */
  create(record: DownloadTokenRecord): Promise<void>;

  /**
   * Atomically gate + consume one download: succeeds ONLY if the token exists, is not
   * revoked, has not expired at `nowIso`, and is under its `maxDownloads` cap (if any),
   * incrementing `downloadCount` in the same conditional write. Returns the updated
   * record on success, or `null` when any gate fails (missing / revoked / expired /
   * exhausted) — a single uniform "no" with no oracle, and race-safe under concurrency.
   */
  claim(token: string, nowIso: string): Promise<DownloadTokenRecord | null>;
}
