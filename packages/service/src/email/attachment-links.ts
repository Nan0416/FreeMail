/**
 * Inserts download links for outbound LARGE attachments (#14) into the email body. A
 * large attachment isn't embedded in the MIME — it's uploaded to S3 and delivered as a
 * `GET /d/{token}` link the recipient clicks. This appends a small "attachments" block
 * to the text and/or HTML body.
 *
 * Injection safety: the filename is caller-supplied (a human composing, or an agent via
 * MCP), so it is HTML-escaped in the HTML block and control-char-stripped in the text
 * block. The URL is FreeMail's own (a known base + a base64url token), but is escaped too
 * as defense in depth. The sender's own body is appended to verbatim — it is their content.
 */

/** One large attachment delivered as a link. */
export interface DownloadLink {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly url: string;
}

/** How long the links stay live, shown to the recipient (kept in sync with the token TTL). */
const LINK_VALIDITY_LABEL = '30 days';

/**
 * Append a download-links block to whichever body parts exist. Returns the body unchanged
 * when there are no links. Never invents a body part that wasn't already present.
 */
export function appendDownloadLinks(
  body: { text?: string; html?: string },
  links: DownloadLink[],
): { text?: string; html?: string } {
  if (links.length === 0) {
    return body;
  }
  const result: { text?: string; html?: string } = {};
  if (body.text !== undefined) {
    result.text = `${body.text}\n\n${textBlock(links)}`;
  }
  if (body.html !== undefined) {
    result.html = `${body.html}${htmlBlock(links)}`;
  }
  return result;
}

function textBlock(links: DownloadLink[]): string {
  const lines = links.map(
    (link) => `- ${sanitizeText(link.filename)} (${formatBytes(link.sizeBytes)}): ${link.url}`,
  );
  return [
    '--',
    `Large attachment${links.length > 1 ? 's' : ''} (available for ${LINK_VALIDITY_LABEL}):`,
    ...lines,
  ].join('\n');
}

function htmlBlock(links: DownloadLink[]): string {
  const items = links
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.filename)}</a> ` +
        `(${escapeHtml(formatBytes(link.sizeBytes))})</li>`,
    )
    .join('');
  return (
    `<div><p>Large attachment${links.length > 1 ? 's' : ''} ` +
    `(available for ${LINK_VALIDITY_LABEL}):</p><ul>${items}</ul></div>`
  );
}

/** HTML-escape the five significant characters so attacker-controlled text can't break out. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Control chars (incl. CR/LF/TAB/DEL) + Unicode line/para separators — stripped from the text block. */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_LINE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

function sanitizeText(value: string): string {
  return value.replace(CONTROL_AND_LINE, '');
}

/** A short human-readable byte size, e.g. `4.8 MB` / `512 KB` / `900 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 100, none above — reads naturally (4.8 MB, 512 KB, 240 MB).
  const rounded = value < 100 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
