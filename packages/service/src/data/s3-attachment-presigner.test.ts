import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { contentDispositionForDownload } from '../email/content-disposition.js';
import { S3AttachmentPresigner } from './s3-attachment-presigner.js';

// Static creds so getSignedUrl signs offline (no network, no provider chain).
const client = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secretExampleKey' },
});

describe('S3AttachmentPresigner', () => {
  it('signs a GET that forces an octet-stream attachment download', async () => {
    const presigner = new S3AttachmentPresigner('mail-bucket', client);
    // A hostile filename with a quote + CRLF must survive as a safe, single-line header.
    const disposition = contentDispositionForDownload('e"vil\r\nX-Injected: 1.pdf');

    const url = await presigner.presign({
      key: 'attachments/inbound/i1/0',
      contentType: 'application/octet-stream',
      contentDisposition: disposition,
      expiresInSeconds: 60,
    });

    const parsed = new URL(url);
    // The response-header overrides are signed into the URL → S3 returns them on GET.
    expect(parsed.searchParams.get('response-content-type')).toBe('application/octet-stream');
    const rcd = parsed.searchParams.get('response-content-disposition');
    expect(rcd).toBe(disposition);
    expect(rcd).toMatch(/^attachment;/);
    // No header break-out survived into the signed value.
    expect(rcd).not.toContain('\r');
    expect(rcd).not.toContain('\n');
    expect(rcd).not.toMatch(/\r?\nX-Injected/);
    // Short-lived + genuinely signed.
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(parsed.pathname).toContain('attachments/inbound/i1/0');
  });
});
