/**
 * Download-token primitives for the outbound large-attachment flow (#14): mint the
 * token, derive the server-side S3 key, and build the public download URL.
 *
 * The token is 256 bits of randomness (base64url). It is the SOLE capability guarding
 * an UNAUTHENTICATED endpoint, so — unlike the read API's non-secret `email-ref` handle
 * — it must be unguessable and never enumerable: the download path looks it up by exact
 * partition key only. base64url ([A-Za-z0-9_-]) is URL-path-safe, so the raw token drops
 * straight into `/d/<token>` without any encoding.
 */
import { randomBytes } from 'node:crypto';

/** 256-bit token → ~43 base64url chars. Unguessable; the whole security of the endpoint. */
const TOKEN_BYTES = 32;

/** Mint a fresh, high-entropy download token. */
export function generateDownloadToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Server-side S3 key for an outbound large attachment. Opaque, never returned to a
 * client, and namespaced by the sending email's id so a message's uploads group together.
 * Mirrors the inbound layout (`attachments/inbound/...`).
 */
export function outboundAttachmentKey(emailId: string, index: number): string {
  return `attachments/outbound/${emailId}/${index}`;
}

/**
 * Build the public download link for a token. `baseUrl` is the API's own public base
 * (e.g. `https://abc.execute-api.us-east-1.amazonaws.com`); a trailing slash is tolerated.
 * The token is base64url, so no path encoding is needed.
 */
export function downloadUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/d/${token}`;
}
