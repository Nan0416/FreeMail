/**
 * The slice of `fetch` the client uses, so any implementation (the global `fetch`, `undici`, a test fake) can be
 * passed in. The types need TypeScript 5.7 or later (`Uint8Array<ArrayBuffer>`) and the DOM or Node.js typings
 * (`AbortSignal`).
 */
export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface FetchLikeInit {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  /** `Uint8Array<ArrayBuffer>`, not any `Uint8Array`: the DOM's and Node.js's `fetch` types refuse a view of a `SharedArrayBuffer`. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly signal: AbortSignal;
  /** `error` on API calls, so the API key never follows a redirect to another host. */
  readonly redirect?: 'error' | 'follow' | 'manual';
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}
