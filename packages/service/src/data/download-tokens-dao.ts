/**
 * Persistence seam for outbound large-attachment download tokens (#14). The download
 * service depends on this interface, not on DynamoDB, so the token lifecycle (mint on send,
 * claim on `GET /d/{token}`) is unit-testable against an in-memory fake. The DynamoDB
 * implementation lives in `ddb-download-tokens-dao.ts`.
 *
 * A token is the SOLE capability for an unauthenticated download, so the record's `s3Key` is
 * server-side only and never leaves the backend — the read path 302s to a freshly minted
 * presigned GET, so the bucket/key are never disclosed to a client.
 */

export interface CreateDownloadTokenInput {
  /** High-entropy random token (the partition key). The capability itself. */
  readonly token: string;
  /** Server-side S3 pointer to the uploaded attachment. NEVER returned to a client. */
  readonly s3Key: string;
  /** Original filename, for the download's `Content-Disposition`. */
  readonly filename: string;
  /** Stored content type — metadata only; the download is always served as an octet-stream. */
  readonly contentType: string;
  readonly sizeBytes: number;
  /** FreeMail id of the sent message this attachment belongs to (correlation). */
  readonly emailId: string;
  /** Mint time, ISO-8601 UTC. */
  readonly createdAt: string;
  /**
   * Server-authoritative expiry, ISO-8601 UTC. Enforced on every claim (a claim past this
   * instant fails closed). DynamoDB TTL (`ttl`) only garbage-collects the row later.
   */
  readonly expiresAt: string;
  /** DynamoDB TTL attribute (epoch seconds = `expiresAt`). Best-effort cleanup, not the gate. */
  readonly ttl: number;
  /** Revoked tokens fail closed on claim (the revoke endpoint/UI is #35). */
  readonly revoked: boolean;
  /** How many times the token has been successfully claimed. */
  readonly downloadCount: number;
  /** Optional cap; when set, a claim past the cap fails closed. Multi-use (unlimited) when absent. */
  readonly maxDownloads?: number;
}

/** Nothing to report: the conditional put either landed or threw. */
export interface CreateDownloadTokenOutput {}

export interface ClaimDownloadTokenInput {
  /** The presented token — the capability itself. */
  readonly token: string;
  /** Server clock at claim time, ISO-8601 UTC. Compared against `expiresAt`. */
  readonly nowIso: string;
}

/** One stored token row, as read back after a successful claim. */
export interface ClaimDownloadTokenOutput extends CreateDownloadTokenInput {}

export interface DownloadTokensDao {
  /**
   * Store a new token row. Conditional on the token not already existing, so an
   * (astronomically unlikely) token collision can never clobber an existing row.
   */
  createDownloadToken(input: CreateDownloadTokenInput): Promise<CreateDownloadTokenOutput>;

  /**
   * Atomically gate + consume one download: succeeds ONLY if the token exists, is not
   * revoked, has not expired at `nowIso`, and is under its `maxDownloads` cap (if any),
   * incrementing `downloadCount` in the same conditional write. Returns the updated record
   * on success, or `null` when any gate fails (missing / revoked / expired / exhausted) — a
   * single uniform "no" with no oracle, and race-safe under concurrency.
   */
  claimDownloadToken(input: ClaimDownloadTokenInput): Promise<ClaimDownloadTokenOutput | null>;
}
