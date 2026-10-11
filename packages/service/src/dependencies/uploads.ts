/**
 * Upload wiring shared by the REST and MCP dependency factories, which both send mail.
 */
import { DEFAULT_EMBED_ATTACHMENT_BYTES, DEFAULT_EMBED_TOTAL_BYTES } from '@freemail/shared';
import { S3Client } from '@aws-sdk/client-s3';

/**
 * The S3 client that signs attachment-upload URLs. It computes request checksums only when an
 * operation requires them: by default the SDK would presign a CRC32 of the EMPTY body it was
 * given, and S3 would then reject every real upload with a checksum mismatch.
 */
export function createUploadPresignClient(): S3Client {
  return new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
}

/** The embed limits in force: what the send path enforces and the MCP tool text states. */
export interface EmbedLimits {
  readonly embedMaxBytes: number;
  readonly embedTotalBytes: number;
}

/**
 * The deploy-configured embed limits with the defaults applied — resolved in one place, so the
 * numbers `EmailService` enforces and the numbers the MCP descriptions state cannot differ.
 */
export function embedLimits(config: {
  readonly embedMaxBytes: number | undefined;
  readonly embedTotalBytes: number | undefined;
}): EmbedLimits {
  return {
    embedMaxBytes: config.embedMaxBytes ?? DEFAULT_EMBED_ATTACHMENT_BYTES,
    embedTotalBytes: config.embedTotalBytes ?? DEFAULT_EMBED_TOTAL_BYTES,
  };
}
