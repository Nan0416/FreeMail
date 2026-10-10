import { MAX_UPLOAD_BYTES, UPLOAD_URL_TTL_SECONDS } from '@freemail/shared';
import { describe, expect, it } from 'vitest';
import type {
  UploadDeclaration,
  UploadStore,
  UploadedObject,
} from '../../src/facades/s3-upload-store.js';
import {
  AttachmentUploadService,
  isValidUploadId,
  uploadKey,
} from '../../src/services/attachment-upload-service.js';
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

const NOW = new Date('2026-10-10T00:00:00.000Z');
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';

function service(uploads = new FakeUploads()) {
  return {
    uploads,
    svc: new AttachmentUploadService({ uploads, now: () => NOW, generateId: () => ID }),
  };
}

describe('AttachmentUploadService.create', () => {
  it('presigns a PUT for exactly the declared size at uploads/<id>', async () => {
    const t = service();

    const result = await t.svc.create({
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
    await t.svc.create({ filename: 'blob', sizeBytes: 1 });
    expect(t.uploads.presigned[0]?.declaration.contentType).toBe('application/octet-stream');
  });

  it('accepts up to 100 MB and rejects anything else — before presigning', async () => {
    const t = service();
    await expect(
      t.svc.create({ filename: 'big', sizeBytes: MAX_UPLOAD_BYTES }),
    ).resolves.toBeDefined();
    for (const sizeBytes of [0, -1, 1.5, MAX_UPLOAD_BYTES + 1, Number.NaN]) {
      await expect(t.svc.create({ filename: 'x', sizeBytes })).rejects.toBeInstanceOf(EmailError);
    }
    expect(t.uploads.presigned).toHaveLength(1);
  });

  it('rejects an empty or overlong filename and a malformed content type', async () => {
    const t = service();
    await expect(t.svc.create({ filename: '   ', sizeBytes: 1 })).rejects.toThrow(/filename/);
    await expect(t.svc.create({ filename: 'x'.repeat(256), sizeBytes: 1 })).rejects.toThrow(
      /filename/,
    );
    await expect(
      t.svc.create({ filename: 'x', contentType: 'not a type', sizeBytes: 1 }),
    ).rejects.toThrow(/contentType/);
  });

  it('mints unguessable ids by default (16 random bytes, base64url)', async () => {
    const uploads = new FakeUploads();
    const svc = new AttachmentUploadService({ uploads });
    const a = await svc.create({ filename: 'a', sizeBytes: 1 });
    const b = await svc.create({ filename: 'b', sizeBytes: 1 });
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
