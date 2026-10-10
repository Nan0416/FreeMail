/**
 * Upload wiring shared by the REST and MCP dependency factories, which both send mail.
 */
import { S3Client } from '@aws-sdk/client-s3';

/**
 * The S3 client that signs attachment-upload URLs. It computes request checksums only when an
 * operation requires them: by default the SDK would presign a CRC32 of the EMPTY body it was
 * given, and S3 would then reject every real upload with a checksum mismatch.
 */
export function createUploadPresignClient(): S3Client {
  return new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
}

/** The deploy-configured embed limits, spread into `EmailServiceDeps` (absent → defaults). */
export function embedLimits(config: {
  readonly embedMaxBytes: number | undefined;
  readonly embedTotalBytes: number | undefined;
}): { embedMaxBytes?: number; embedTotalBytes?: number } {
  return {
    ...(config.embedMaxBytes !== undefined ? { embedMaxBytes: config.embedMaxBytes } : {}),
    ...(config.embedTotalBytes !== undefined ? { embedTotalBytes: config.embedTotalBytes } : {}),
  };
}
