import { DOWNLOAD_PRESIGN_TTL_SECONDS } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type { DownloadTokenRecord, DownloadTokensRepo } from '../data/download-tokens-repo.js';
import type { AttachmentPresigner, PresignRequest } from '../data/s3-attachment-presigner.js';
import { contentDispositionForDownload } from './content-disposition.js';
import { DownloadService } from './download-service.js';

class FakeTokens implements DownloadTokensRepo {
  claimResult: DownloadTokenRecord | null = null;
  readonly claimCalls: { token: string; nowIso: string }[] = [];
  create(): Promise<void> {
    return Promise.resolve();
  }
  claim(token: string, nowIso: string): Promise<DownloadTokenRecord | null> {
    this.claimCalls.push({ token, nowIso });
    return Promise.resolve(this.claimResult);
  }
}

class FakePresigner implements AttachmentPresigner {
  readonly calls: PresignRequest[] = [];
  url = 'https://s3.example.com/signed-get';
  presign(req: PresignRequest): Promise<string> {
    this.calls.push(req);
    return Promise.resolve(this.url);
  }
}

function record(overrides: Partial<DownloadTokenRecord> = {}): DownloadTokenRecord {
  return {
    token: 'tok-1',
    s3Key: 'attachments/outbound/email-1/0',
    filename: 'the report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 5 * 1024 * 1024,
    emailId: 'email-1',
    createdAt: '2026-07-18T00:00:00.000Z',
    expiresAt: '2026-08-17T00:00:00.000Z',
    ttl: 1,
    revoked: false,
    downloadCount: 1,
    ...overrides,
  };
}

const FIXED_NOW = new Date('2026-07-18T12:00:00.000Z');
/** A well-formed token: exactly 43 base64url chars, matching the minted shape. */
const VALID_TOKEN = 'A'.repeat(43);

function makeService(tokens: FakeTokens, presigner: FakePresigner): DownloadService {
  return new DownloadService({ tokens, presigner, now: () => FIXED_NOW });
}

describe('DownloadService.resolve', () => {
  it('claims the token then presigns a short-lived octet-stream GET, never exposing the key', async () => {
    const tokens = new FakeTokens();
    tokens.claimResult = record();
    const presigner = new FakePresigner();
    const service = makeService(tokens, presigner);

    const result = await service.resolve(VALID_TOKEN);

    expect(result).toEqual({ url: 'https://s3.example.com/signed-get' });
    expect(tokens.claimCalls).toEqual([{ token: VALID_TOKEN, nowIso: FIXED_NOW.toISOString() }]);
    expect(presigner.calls).toHaveLength(1);
    expect(presigner.calls[0]).toEqual({
      key: 'attachments/outbound/email-1/0',
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload('the report.pdf'),
      expiresInSeconds: DOWNLOAD_PRESIGN_TTL_SECONDS,
    });
  });

  it('returns null (uniform failure) when the claim fails — and never presigns', async () => {
    const tokens = new FakeTokens();
    tokens.claimResult = null; // missing / revoked / expired / exhausted all look identical here
    const presigner = new FakePresigner();
    const service = makeService(tokens, presigner);

    expect(await service.resolve(VALID_TOKEN)).toBeNull();
    expect(presigner.calls).toHaveLength(0);
  });

  // Shape is validated BEFORE any DB call, so a malformed token can never reach the store
  // (an overlong one would otherwise throw a DynamoDB ValidationException → 500).
  it.each([
    ['empty', ''],
    ['too short', 'A'.repeat(42)],
    ['too long', 'A'.repeat(44)],
    ['overlong past the DynamoDB key limit', 'A'.repeat(5000)],
    ['non-base64url character', `${'A'.repeat(42)}+`],
  ])('returns null for a %s token without touching the store', async (_label, token) => {
    const tokens = new FakeTokens();
    const presigner = new FakePresigner();
    const service = makeService(tokens, presigner);

    expect(await service.resolve(token)).toBeNull();
    expect(tokens.claimCalls).toHaveLength(0);
    expect(presigner.calls).toHaveLength(0);
  });
});
