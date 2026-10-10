import {
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
} from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type {
  ClaimDownloadTokenInput,
  ClaimDownloadTokenOutput,
  CreateDownloadTokenOutput,
  DownloadTokensDao,
  GetDownloadTokenOutput,
} from '../../src/data/download-tokens-dao.js';
import type {
  AttachmentPresigner,
  PresignRequest,
} from '../../src/facades/s3-attachment-presigner.js';
import type {
  UploadDeclaration,
  UploadStore,
  UploadedObject,
} from '../../src/facades/s3-upload-store.js';
import {
  AttachmentService,
  isValidUploadId,
  uploadKey,
} from '../../src/services/attachment-service.js';
import { contentDispositionForDownload } from '../../src/utils/content-disposition.js';
import { EmailError } from '../../src/utils/errors.js';

class FakeUploads implements UploadStore {
  readonly presigned: { key: string; declaration: UploadDeclaration; expiresIn: number }[] = [];
  presignPut(key: string, declaration: UploadDeclaration, expiresIn: number): Promise<string> {
    this.presigned.push({ key, declaration, expiresIn });
    return Promise.resolve(`https://bucket.s3.example/${key}?signed`);
  }
  head(): Promise<UploadedObject | null> {
    return Promise.resolve(null);
  }
  copy(): Promise<void> {
    return Promise.resolve();
  }
  getBytes(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
}

class FakeTokens implements DownloadTokensDao {
  claimResult: ClaimDownloadTokenOutput | null = null;
  readonly claimCalls: { token: string; nowIso: string }[] = [];
  createDownloadToken(): Promise<CreateDownloadTokenOutput> {
    return Promise.resolve({});
  }
  claimDownloadToken(input: ClaimDownloadTokenInput): Promise<ClaimDownloadTokenOutput | null> {
    this.claimCalls.push({ token: input.token, nowIso: input.nowIso });
    return Promise.resolve(this.claimResult);
  }
  getDownloadToken(): Promise<GetDownloadTokenOutput | null> {
    return Promise.resolve(null);
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

function record(overrides: Partial<ClaimDownloadTokenOutput> = {}): ClaimDownloadTokenOutput {
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

const NOW = new Date('2026-10-10T00:00:00.000Z');
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
/** A well-formed link token: exactly 43 base64url chars, matching the minted shape. */
const VALID_TOKEN = 'A'.repeat(43);

function service(uploads = new FakeUploads()) {
  const tokens = new FakeTokens();
  const presigner = new FakePresigner();
  return {
    uploads,
    tokens,
    presigner,
    svc: new AttachmentService({
      uploads,
      tokensDao: tokens,
      presigner,
      now: () => NOW,
      generateId: () => ID,
    }),
  };
}

describe('AttachmentService.createAttachmentUpload', () => {
  it('presigns a PUT for exactly the declared size at uploads/<id>', async () => {
    const t = service();

    const result = await t.svc.createAttachmentUpload({
      filename: '  report.pdf ',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });

    expect(result).toEqual({
      uploadId: ID,
      uploadUrl: `https://bucket.s3.example/uploads/${ID}?signed`,
      uploadMethod: 'PUT',
      expiresAt: new Date(NOW.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    });
    expect(t.uploads.presigned).toEqual([
      {
        key: uploadKey(ID),
        declaration: { filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 1234 },
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      },
    ]);
  });

  it('defaults the content type to application/octet-stream', async () => {
    const t = service();
    await t.svc.createAttachmentUpload({ filename: 'blob', sizeBytes: 1 });
    expect(t.uploads.presigned[0]?.declaration.contentType).toBe('application/octet-stream');
  });

  it('accepts up to 100 MB and rejects anything else — before presigning', async () => {
    const t = service();
    await expect(
      t.svc.createAttachmentUpload({ filename: 'big', sizeBytes: MAX_UPLOAD_BYTES }),
    ).resolves.toBeDefined();
    for (const sizeBytes of [0, -1, 1.5, MAX_UPLOAD_BYTES + 1, Number.NaN]) {
      await expect(
        t.svc.createAttachmentUpload({ filename: 'x', sizeBytes }),
      ).rejects.toBeInstanceOf(EmailError);
    }
    expect(t.uploads.presigned).toHaveLength(1);
  });

  it('rejects an empty or overlong filename and a malformed content type', async () => {
    const t = service();
    await expect(t.svc.createAttachmentUpload({ filename: '   ', sizeBytes: 1 })).rejects.toThrow(
      /filename/,
    );
    await expect(
      t.svc.createAttachmentUpload({ filename: 'x'.repeat(256), sizeBytes: 1 }),
    ).rejects.toThrow(/filename/);
    await expect(
      t.svc.createAttachmentUpload({ filename: 'x', contentType: 'not a type', sizeBytes: 1 }),
    ).rejects.toThrow(/contentType/);
  });

  it('rejects a filename too long for S3 metadata once encoded, before presigning', async () => {
    const t = service();
    // Each CJK character encodes to 9 bytes: 200 of them (1800) is the limit, 201 is over —
    // both well within the 255-character limit.
    await expect(
      t.svc.createAttachmentUpload({ filename: '文'.repeat(201), sizeBytes: 1 }),
    ).rejects.toThrow(/too long/);
    await expect(
      t.svc.createAttachmentUpload({ filename: '文'.repeat(200), sizeBytes: 1 }),
    ).resolves.toBeDefined();
    expect(t.uploads.presigned).toHaveLength(1);
  });

  it('mints unguessable ids by default (16 random bytes, base64url)', async () => {
    const svc = new AttachmentService({
      uploads: new FakeUploads(),
      tokensDao: new FakeTokens(),
      presigner: new FakePresigner(),
    });
    const a = await svc.createAttachmentUpload({ filename: 'a', sizeBytes: 1 });
    const b = await svc.createAttachmentUpload({ filename: 'b', sizeBytes: 1 });
    expect(isValidUploadId(a.uploadId)).toBe(true);
    expect(a.uploadId).not.toBe(b.uploadId);
  });
});

describe('isValidUploadId', () => {
  it('accepts only the 22-character base64url shape this service mints', () => {
    expect(isValidUploadId(ID)).toBe(true);
    expect(isValidUploadId('short')).toBe(false);
    expect(isValidUploadId('../uploads/AAAAAAAAAAAAAAAA')).toBe(false);
    expect(isValidUploadId(42)).toBe(false);
  });
});

describe('AttachmentService.resolveAttachmentDownloadPresignedUrl', () => {
  it('claims the token then presigns a short-lived octet-stream GET, never exposing the key', async () => {
    const t = service();
    t.tokens.claimResult = record();

    const result = await t.svc.resolveAttachmentDownloadPresignedUrl({ token: VALID_TOKEN });

    expect(result).toEqual({ url: 'https://s3.example.com/signed-get' });
    expect(t.tokens.claimCalls).toEqual([{ token: VALID_TOKEN, nowIso: NOW.toISOString() }]);
    expect(t.presigner.calls).toHaveLength(1);
    expect(t.presigner.calls[0]).toEqual({
      key: 'attachments/outbound/email-1/0',
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload('the report.pdf'),
      expiresInSeconds: DOWNLOAD_PRESIGN_TTL_SECONDS,
    });
  });

  it('returns null (uniform failure) when the claim fails — and never presigns', async () => {
    const t = service();
    t.tokens.claimResult = null; // missing / revoked / expired / exhausted all look identical here

    expect(await t.svc.resolveAttachmentDownloadPresignedUrl({ token: VALID_TOKEN })).toBeNull();
    expect(t.presigner.calls).toHaveLength(0);
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
    const t = service();

    expect(await t.svc.resolveAttachmentDownloadPresignedUrl({ token })).toBeNull();
    expect(t.tokens.claimCalls).toHaveLength(0);
    expect(t.presigner.calls).toHaveLength(0);
  });
});
