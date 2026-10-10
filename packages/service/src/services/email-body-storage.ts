/**
 * Store a message's decoded body once — when an inbound message is ingested, or when a message
 * is sent — and read it back when the message is opened. Opening a message therefore costs a
 * row read (plus, for a large body, one small S3 read) instead of fetching and re-parsing the
 * whole raw MIME, attachments included.
 *
 * Small bodies live inline in the emails row: the list reads a lean GSI, so a fat row never
 * slows the list. Larger bodies go to S3 at `bodies/<direction>/<id>.json`, which sits outside
 * the expiring `inbound/` prefix and never re-triggers the inbound parser.
 */
import { MAX_EMAIL_RESPONSE_BYTES, MAX_READ_BODY_BYTES } from '@freemail/shared';
import type { StoredEmailBody } from '../data/emails-dao.js';
import type { MailBodyContent, MailBodyStore } from '../facades/s3-mail-body-store.js';
import { fitBodyToBudget } from '../utils/body-budget.js';

/**
 * Bodies up to this many UTF-8 bytes (text + HTML) are kept inline in the emails row. The rest
 * of an inbound row is bounded at roughly 50 KB (capped addresses, subject, attachment
 * descriptors), so an inline body this size keeps the row well under DynamoDB's 400 KB item limit.
 */
export const MAX_INLINE_BODY_BYTES = 256 * 1024;

/** The S3 key for a body stored outside the row. */
export function bodyKey(direction: 'sent' | 'inbound', id: string): string {
  return `bodies/${direction}/${id}.json`;
}

/**
 * Cap a body to what the reader can show, then store it inline or in S3. Returns the row's
 * pointer, or undefined when there is no body at all. The S3 write happens BEFORE the caller
 * writes the row (the row is the commit marker), so a row never points at a missing object.
 */
export async function storeEmailBody(
  store: MailBodyStore,
  key: string,
  text: string | undefined,
  html: string | undefined,
): Promise<StoredEmailBody | undefined> {
  if (text === undefined && html === undefined) {
    return undefined;
  }
  // The same per-part cap the reader applied when it re-parsed raw MIME, so what is stored is
  // exactly what used to be shown. The response budget is re-applied at read time, when the
  // envelope's size is known.
  const fitted = fitBodyToBudget(text, html, {
    partCapBytes: MAX_READ_BODY_BYTES,
    serializedBudgetBytes: MAX_EMAIL_RESPONSE_BYTES,
  });
  const content: MailBodyContent = {
    ...(fitted.text !== undefined ? { text: fitted.text } : {}),
    ...(fitted.html !== undefined ? { html: fitted.html } : {}),
    ...(fitted.truncated ? { truncated: true } : {}),
  };
  if (utf8Bytes(content.text) + utf8Bytes(content.html) <= MAX_INLINE_BODY_BYTES) {
    return { kind: 'inline', ...content };
  }
  await store.putBody(key, content);
  return { kind: 's3', s3Key: key };
}

/** Read a stored body back; null when its S3 object is missing or unreadable. */
export async function loadEmailBody(
  store: MailBodyStore,
  body: StoredEmailBody,
): Promise<MailBodyContent | null> {
  if (body.kind === 's3') {
    return store.getBody(body.s3Key);
  }
  return {
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.html !== undefined ? { html: body.html } : {}),
    ...(body.truncated ? { truncated: true } : {}),
  };
}

function utf8Bytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}
