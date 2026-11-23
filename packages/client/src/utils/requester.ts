import type { z } from 'zod';
import { DEFAULT_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS } from '../constants.js';
import { createFreeMailApiError, FreeMailResponseValidationError, FreeMailUploadError, type FreeMailApiErrorClasses } from '../errors/common.js';
import type { FetchLike } from '../types/http.js';
import type { FreeMailRequestOptions } from '../types/service.js';
import { validateValue } from './schema-validator.js';

export interface FreeMailRequesterProps {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

/** Sends each API call with the API key, turns an error response into a typed error, and validates the response body. */
export class FreeMailRequester {
  /** Always ends in `/`, so a path joins onto it without dropping a path prefix. */
  private readonly baseUrl: URL;
  /** A `#` field, so logging the client never prints the key. */
  readonly #apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(props: FreeMailRequesterProps) {
    this.baseUrl = parseBaseUrl(props.baseUrl);
    if (typeof props.apiKey !== 'string' || props.apiKey.trim() === '') {
      throw new TypeError('FreeMail client: apiKey is required.');
    }
    this.#apiKey = props.apiKey;
    this.timeoutMs = requireTimeout(props.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    // Called through a wrapper: some runtimes reject `fetch` called with another `this`.
    this.fetchFn = props.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** `path` is URI-encoded already, as it goes on the wire, and starts with `/`. */
  get<T>(path: string, schema: z.ZodType<T>, errorClasses: FreeMailApiErrorClasses, options: FreeMailRequestOptions = {}): Promise<T> {
    return this.call('GET', path, undefined, schema, errorClasses, options);
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>, errorClasses: FreeMailApiErrorClasses, options: FreeMailRequestOptions = {}): Promise<T> {
    return this.call('POST', path, body, schema, errorClasses, options);
  }

  /** PUTs an attachment's bytes to its presigned upload URL. The URL is the credential: the API key is never sent to S3. */
  async putUpload(uploadUrl: string, content: Uint8Array, contentType: string | undefined, options: FreeMailRequestOptions = {}): Promise<void> {
    const response = await this.fetchFn(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType ?? 'application/octet-stream' },
      // A file's bytes (a Buffer from `readFile`, say) sit in an ArrayBuffer; fetch refuses a SharedArrayBuffer view anyway.
      body: content as Uint8Array<ArrayBuffer>,
      signal: this.signalFor(options, DEFAULT_UPLOAD_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new FreeMailUploadError(response.status, readS3ErrorCode(text));
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, schema: z.ZodType<T>, errorClasses: FreeMailApiErrorClasses, options: FreeMailRequestOptions): Promise<T> {
    const request = `${method} ${path}`;
    const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': this.#apiKey };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.fetchFn(new URL(path.slice(1), this.baseUrl).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signalFor(options, this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw createFreeMailApiError(request, response.status, text, errorClasses);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new FreeMailResponseValidationError(request, `the body is not JSON: ${text.slice(0, 100)}`);
    }
    const result = validateValue(schema, value, 'response');
    if (!result.ok) {
      throw new FreeMailResponseValidationError(request, result.errors);
    }
    return result.value;
  }

  /** Aborts on the caller's signal or at the timeout, whichever comes first; fetch then rejects with that reason. */
  private signalFor(options: FreeMailRequestOptions, defaultTimeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(requireTimeout(options.timeoutMs ?? defaultTimeoutMs, 'timeoutMs'));
    return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`FreeMail client: baseUrl is not a URL: ${String(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`FreeMail client: baseUrl must be an http(s) URL: ${value}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError(`FreeMail client: baseUrl must not have a query or fragment: ${value}`);
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function requireTimeout(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`FreeMail client: ${name} must be a positive number of milliseconds.`);
  }
  return value;
}

/** S3 answers an error with XML: `<Error><Code>SignatureDoesNotMatch</Code>...`. */
function readS3ErrorCode(body: string): string | null {
  const match = /<Code>([^<]{1,100})<\/Code>/.exec(body);
  return match === null ? null : match[1];
}
