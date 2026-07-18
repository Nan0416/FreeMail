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
   * Base URL of the FreeMail HTTP API, with no trailing slash, e.g.
   * `https://abc123.execute-api.us-east-1.amazonaws.com`.
   */
  apiBaseUrl: string;
  /**
   * Whether inbound email is enabled for this deploy. CDK writes it from
   * `FreeMailConfig.inbound.enabled` at deploy time. The SPA gates the whole inbox
   * UI on it: an empty inbound timeline is indistinguishable from "inbound disabled",
   * so this deploy-time flag is the authoritative signal (sent history always shows).
   */
  inboundEnabled: boolean;
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
  const { apiBaseUrl, inboundEnabled } = input;
  if (typeof apiBaseUrl !== 'string' || apiBaseUrl.trim().length === 0) {
    throw new Error('WebRuntimeConfig: "apiBaseUrl" must be a non-empty string.');
  }
  // Absent → false (a pre-#12 config.json is tolerated); present-but-wrong-type fails loud.
  if (inboundEnabled !== undefined && typeof inboundEnabled !== 'boolean') {
    throw new Error('WebRuntimeConfig: "inboundEnabled" must be a boolean.');
  }
  return { apiBaseUrl: normalizeBaseUrl(apiBaseUrl), inboundEnabled: inboundEnabled === true };
}
