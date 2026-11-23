import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FreeMailClientImpl } from '../../src/clients/freemail-client-impl.js';
import { FreeMailApiError, FreeMailAuthError, FreeMailEmailNotFoundError, FreeMailResponseValidationError, FreeMailUploadError } from '../../src/errors/common.js';
import type { FetchLike } from '../../src/types/http.js';
import { API_KEY, BASE_URL, buildServiceEmailDetail, EMAIL_ID, fakeFetch, hangingFetch, type FakeReply, type RecordedRequest } from '../fakes.js';

const SENT = { id: 'sent-1', messageId: 'ses-1', sentAt: '2026-11-13T17:00:00.000Z' };
const UPLOAD = { uploadId: 'up-1', uploadUrl: 'https://s3.example/uploads/up-1?X-Amz-Signature=abc', uploadMethod: 'PUT', expiresAt: '2026-11-13T17:15:00.000Z' };

function clientReplying(reply: (request: RecordedRequest) => FakeReply) {
  const http = fakeFetch(reply);
  return { http, client: new FreeMailClientImpl({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: http.fetch }) };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to reject.');
    },
    (error: unknown) => error,
  );
}

describe('FreeMailClientImpl construction', () => {
  it.each([
    ['a baseUrl that is not a URL', { baseUrl: 'api.example.com', apiKey: API_KEY }],
    ['a baseUrl that is not http(s)', { baseUrl: 'ftp://api.example.com', apiKey: API_KEY }],
    ['a baseUrl with a query', { baseUrl: 'https://api.example.com/?a=1', apiKey: API_KEY }],
    ['an empty apiKey', { baseUrl: BASE_URL, apiKey: ' ' }],
    ['a zero timeout', { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 0 }],
    ['an infinite timeout', { baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: Infinity }],
  ])('rejects %s', (_label, props) => {
    expect(() => new FreeMailClientImpl(props)).toThrow(TypeError);
  });

  it('never prints the API key when the client is logged', () => {
    const fake = clientReplying(() => ({ body: SENT }));
    expect(inspect(fake.client, { depth: 10 })).not.toContain(API_KEY);
    expect(JSON.stringify(fake.client)).not.toContain(API_KEY);
  });
});

describe('FreeMailClientImpl.sendEmail', () => {
  const REQUEST = { from: 'agent@corp.example', to: ['sam@example.com'], subject: 'Hi', text: 'Hello.', idempotencyKey: 'order-42' };

  it('POSTs the request as JSON to /emails with the API key', async () => {
    const fake = clientReplying(() => ({ body: SENT }));

    await expect(fake.client.sendEmail(REQUEST)).resolves.toEqual(SENT);

    expect(fake.http.requests).toHaveLength(1);
    const request = fake.http.requests[0];
    expect(request.url).toBe('https://api.example.com/emails');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json', 'x-api-key': API_KEY });
    expect(JSON.parse(String(request.init.body))).toEqual(REQUEST);
  });

  it('keeps a path prefix on the base URL, with or without a trailing slash', async () => {
    for (const baseUrl of ['https://proxy.example/freemail', 'https://proxy.example/freemail/']) {
      const http = fakeFetch(() => ({ body: SENT }));
      await new FreeMailClientImpl({ baseUrl, apiKey: API_KEY, fetch: http.fetch }).sendEmail(REQUEST);
      expect(http.requests[0].url).toBe('https://proxy.example/freemail/emails');
    }
  });

  it('returns a replayed send, keeping fields the client does not know yet', async () => {
    const fake = clientReplying(() => ({ body: { ...SENT, replayed: true, addedLater: 'kept' } }));

    await expect(fake.client.sendEmail(REQUEST)).resolves.toEqual({ ...SENT, replayed: true, addedLater: 'kept' });
  });

  it("throws FreeMailApiError with FreeMail's code and message", async () => {
    const fake = clientReplying(() => ({ status: 400, body: { error: 'invalid_sender', message: 'from must be under corp.example.' } }));

    const error = await caught(fake.client.sendEmail(REQUEST));

    expect(error).toBeInstanceOf(FreeMailApiError);
    expect(error).not.toBeInstanceOf(FreeMailAuthError);
    expect(error).toMatchObject({
      name: 'FreeMailApiError',
      request: 'POST /emails',
      status: 400,
      code: 'invalid_sender',
      message: 'FreeMail POST /emails returned HTTP 400 invalid_sender: from must be under corp.example.',
    });
  });

  it("throws FreeMailAuthError for API Gateway's 403 for a missing or revoked key", async () => {
    const fake = clientReplying(() => ({ status: 403, body: { message: 'Forbidden' } }));

    const error = await caught(fake.client.sendEmail(REQUEST));

    expect(error).toBeInstanceOf(FreeMailAuthError);
    expect(error).toMatchObject({ status: 403, code: null, message: 'FreeMail POST /emails returned HTTP 403: Forbidden' });
  });

  it('throws FreeMailApiError with the start of the body for an error that is not JSON', async () => {
    const fake = clientReplying(() => ({ status: 502, body: 'Bad Gateway' }));

    await expect(fake.client.sendEmail(REQUEST)).rejects.toMatchObject({ name: 'FreeMailApiError', status: 502, code: null, message: expect.stringContaining('Bad Gateway') });
  });

  it('throws FreeMailResponseValidationError for a 200 without a required field', async () => {
    const fake = clientReplying(() => ({ body: { id: 'sent-1', sentAt: SENT.sentAt } }));

    const error = await caught(fake.client.sendEmail(REQUEST));

    expect(error).toBeInstanceOf(FreeMailResponseValidationError);
    expect((error as FreeMailResponseValidationError).details).toContain('response.messageId');
  });

  it('throws FreeMailResponseValidationError for a 200 whose body is not JSON', async () => {
    const fake = clientReplying(() => ({ body: '<html>' }));

    await expect(fake.client.sendEmail(REQUEST)).rejects.toThrow(FreeMailResponseValidationError);
  });

  it('gives up at the timeout, with a TimeoutError', async () => {
    const client = new FreeMailClientImpl({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: hangingFetch, timeoutMs: 5 });

    await expect(client.sendEmail(REQUEST)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("stops when the caller's signal aborts", async () => {
    const client = new FreeMailClientImpl({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: hangingFetch });
    const controller = new AbortController();
    const sent = client.sendEmail(REQUEST, { signal: controller.signal });
    controller.abort(new Error('caller gave up'));

    await expect(sent).rejects.toThrow('caller gave up');
  });

  it('uses the global fetch when none is passed', async () => {
    const original = globalThis.fetch;
    const http = fakeFetch(() => ({ body: SENT }));
    globalThis.fetch = http.fetch as unknown as typeof fetch;
    try {
      await new FreeMailClientImpl({ baseUrl: BASE_URL, apiKey: API_KEY }).sendEmail(REQUEST);
    } finally {
      globalThis.fetch = original;
    }
    expect(http.requests[0].url).toBe('https://api.example.com/emails');
  });
});

describe('FreeMailClientImpl.createAttachmentUpload', () => {
  it('POSTs the declaration to /attachments/uploads', async () => {
    const fake = clientReplying(() => ({ body: UPLOAD }));

    await expect(fake.client.createAttachmentUpload({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 3 })).resolves.toEqual(UPLOAD);

    expect(fake.http.requests[0].url).toBe('https://api.example.com/attachments/uploads');
    expect(JSON.parse(String(fake.http.requests[0].init.body))).toEqual({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 3 });
  });

  it('throws FreeMailResponseValidationError for an upload method other than PUT', async () => {
    const fake = clientReplying(() => ({ body: { ...UPLOAD, uploadMethod: 'POST' } }));

    await expect(fake.client.createAttachmentUpload({ filename: 'a.pdf', sizeBytes: 3 })).rejects.toThrow(FreeMailResponseValidationError);
  });
});

describe('FreeMailClientImpl.uploadAttachment', () => {
  const CONTENT = new TextEncoder().encode('%PDF');

  it('creates an upload for the exact size, then PUTs the bytes to its URL without the API key', async () => {
    const fake = clientReplying((request) => (request.init.method === 'PUT' ? { body: '' } : { body: UPLOAD }));

    await expect(fake.client.uploadAttachment({ filename: 'a.pdf', contentType: 'application/pdf', content: CONTENT })).resolves.toEqual({ uploadId: 'up-1' });

    expect(fake.http.requests.map((request) => `${request.init.method} ${request.url}`)).toEqual(['POST https://api.example.com/attachments/uploads', `PUT ${UPLOAD.uploadUrl}`]);
    expect(JSON.parse(String(fake.http.requests[0].init.body))).toEqual({ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 4 });
    const put = fake.http.requests[1];
    expect(put.init.body).toBe(CONTENT);
    expect(put.init.headers).toEqual({ 'content-type': 'application/pdf' });
  });

  it('declares the default content type when none is given, and sends no content type field', async () => {
    const fake = clientReplying((request) => (request.init.method === 'PUT' ? { body: '' } : { body: UPLOAD }));

    await fake.client.uploadAttachment({ filename: 'blob.bin', content: CONTENT });

    expect(JSON.parse(String(fake.http.requests[0].init.body))).toEqual({ filename: 'blob.bin', sizeBytes: 4 });
    expect(fake.http.requests[1].init.headers).toEqual({ 'content-type': 'application/octet-stream' });
  });

  it("throws FreeMailUploadError with S3's error code when the PUT is refused", async () => {
    const s3Error = '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>...</Message></Error>';
    const fake = clientReplying((request) => (request.init.method === 'PUT' ? { status: 403, body: s3Error } : { body: UPLOAD }));

    const error = await caught(fake.client.uploadAttachment({ filename: 'a.pdf', content: CONTENT }));

    expect(error).toBeInstanceOf(FreeMailUploadError);
    expect(error).toMatchObject({ status: 403, code: 'SignatureDoesNotMatch', message: 'The attachment upload returned HTTP 403 SignatureDoesNotMatch' });
    // The presigned URL is a credential: it stays out of the message.
    expect((error as Error).message).not.toContain('s3.example');
  });

  it('does not PUT when creating the upload fails', async () => {
    const fake = clientReplying(() => ({ status: 400, body: { error: 'invalid_request', message: 'sizeBytes is too large.' } }));

    await expect(fake.client.uploadAttachment({ filename: 'a.pdf', content: CONTENT })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fake.http.requests).toHaveLength(1);
  });
});

describe('FreeMailClientImpl.getEmail', () => {
  it('GETs /api/emails/{id} with the API key and no body', async () => {
    const fake = clientReplying(() => ({ body: buildServiceEmailDetail() }));

    await expect(fake.client.getEmail({ id: EMAIL_ID })).resolves.toEqual(buildServiceEmailDetail());

    const request = fake.http.requests[0];
    expect(request.url).toBe(`https://api.example.com/api/emails/${EMAIL_ID}`);
    expect(request.init.method).toBe('GET');
    expect(request.init.headers).toEqual({ accept: 'application/json', 'x-api-key': API_KEY });
    expect(request.init.body).toBeUndefined();
  });

  it('URI-encodes the id in the path', async () => {
    const fake = clientReplying(() => ({ body: buildServiceEmailDetail() }));

    await fake.client.getEmail({ id: 'a/b c' });

    expect(fake.http.requests[0].url).toBe('https://api.example.com/api/emails/a%2Fb%20c');
  });

  it('keeps fields the client does not know yet', async () => {
    const detail = { ...buildServiceEmailDetail(), addedLater: 'kept' };
    const fake = clientReplying(() => ({ body: detail }));

    await expect(fake.client.getEmail({ id: EMAIL_ID })).resolves.toEqual(detail);
  });

  it('throws FreeMailEmailNotFoundError for 404 not_found', async () => {
    const fake = clientReplying(() => ({ status: 404, body: { error: 'not_found', message: 'No such email.' } }));

    const error = await caught(fake.client.getEmail({ id: EMAIL_ID }));

    expect(error).toBeInstanceOf(FreeMailEmailNotFoundError);
    expect(error).toMatchObject({ name: 'FreeMailEmailNotFoundError', status: 404, code: 'not_found', message: `FreeMail GET /api/emails/${EMAIL_ID} returned HTTP 404 not_found: No such email.` });
  });

  it.each([
    ['without a required field', { to: undefined }],
    ['with a verdict FreeMail does not declare', { spamVerdict: 'MAYBE' }],
    ['with an attachment without its download URL', { attachments: [{ id: '0', filename: 'a', contentType: 'text/plain', sizeBytes: 1 }] }],
  ])('throws FreeMailResponseValidationError for a message %s', async (_label, overrides) => {
    const fake = clientReplying(() => ({ body: { ...buildServiceEmailDetail(), ...overrides } }));

    await expect(fake.client.getEmail({ id: EMAIL_ID })).rejects.toThrow(FreeMailResponseValidationError);
  });
});

describe('FetchLike', () => {
  it('accepts the global fetch', () => {
    const fetchLike: FetchLike = globalThis.fetch;
    expect(typeof fetchLike).toBe('function');
  });
});
