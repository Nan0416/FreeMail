/**
 * Runtime configuration the deployed React SPA fetches on boot. The API endpoint
 * is a deploy-time CloudFormation value — unknown at `vite build` — so the CDK
 * writes it as `config.json` into the web bucket at deploy and the SPA reads it at
 * startup. This is the single source of truth for both the writer (CDK) and the
 * reader (SPA), mirroring how {@link parseFreeMailConfig} guards the deploy config.
 */

/** The runtime config the SPA fetches from `/config.json`. */
export interface WebRuntimeConfig {
  /**
   * Absolute base URL of the FreeMail HTTP API, with no trailing slash, e.g.
   * `https://api.example.com`. As of #47 the SPA calls the API CROSS-ORIGIN at the
   * configured `apiDomain` — this is no longer the same-origin `/api` proxy path.
   *
   * Not asserted to be `https://` here: {@link parseWebRuntimeConfig} also parses the
   * `VITE_API_BASE_URL` dev fallback, which is `http://localhost` under `vite dev`. The
   * deployed value is the only one that must be https, so the CDK writer asserts it.
   */
  readonly apiBaseUrl: string;
  /**
   * Whether inbound email is enabled for this deploy. CDK writes it from
   * `FreeMailConfig.inbound.enabled` at deploy time. The SPA gates the whole inbox
   * UI on it: an empty inbound timeline is indistinguishable from "inbound disabled",
   * so this deploy-time flag is the authoritative signal (sent history always shows).
   */
  readonly inboundEnabled: boolean;
}

/** Trim a base URL and drop a single trailing slash so callers can always append `/path`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an unknown value into a {@link WebRuntimeConfig}, throwing on anything
 * malformed. Fail-loud on purpose: a bad `config.json` should surface as a clear
 * boot error, not a silent default that points the app at nowhere.
 */
export function parseWebRuntimeConfig(input: unknown): WebRuntimeConfig {
  if (!isRecord(input)) {
    throw new Error('WebRuntimeConfig: expected a JSON object.');
  }
  if (typeof input.apiBaseUrl !== 'string' || input.apiBaseUrl.trim().length === 0) {
    throw new Error('WebRuntimeConfig: "apiBaseUrl" must be a non-empty string.');
  }
  // Absent → false (a pre-#12 config.json is tolerated); present-but-wrong-type fails loud.
  if (input.inboundEnabled !== undefined && typeof input.inboundEnabled !== 'boolean') {
    throw new Error('WebRuntimeConfig: "inboundEnabled" must be a boolean.');
  }
  return {
    apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl),
    inboundEnabled: input.inboundEnabled === true,
  };
}
