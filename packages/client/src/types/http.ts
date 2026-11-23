/**
 * The slice of `fetch` the client uses, so any implementation (the global `fetch`, `undici`, a test fake) can be
 * passed in without the client's types depending on DOM or Node.js typings.
 */
export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface FetchLikeInit {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  /** `Uint8Array<ArrayBuffer>`, not any `Uint8Array`: the DOM's and Node.js's `fetch` types refuse a view of a `SharedArrayBuffer`. */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly signal: AbortSignal;
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}
