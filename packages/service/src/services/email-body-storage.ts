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

/** A body is never kept inline above this many UTF-8 bytes (text + HTML), however small its row. */
export const MAX_INLINE_BODY_BYTES = 256 * 1024;

/**
 * A row with an inline body must stay at or under this many bytes in total. DynamoDB caps an
 * item at 400 KB; the gap leaves room for later updates to the row (a sent row's status +
 * `sesMessageId` / `error`). A hostile inbound envelope alone can reach ~130 KB (multi-byte
 * addresses at their caps, 25 attachment descriptors), so the rest of the row is measured
 * rather than assumed.
 */
export const MAX_INLINE_ROW_BYTES = 350 * 1024;

/** The S3 key for a body stored outside the row. */
export function bodyKey(direction: 'sent' | 'inbound', id: string): string {
  return `bodies/${direction}/${id}.json`;
}

/**
 * An upper bound on a row's stored size: its JSON form, which carries every attribute name and
 * value plus punctuation DynamoDB doesn't charge for, so it never under-counts.
 */
export function estimateRowBytes(row: object): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}

export interface StoreEmailBodyInput {
  /** Where the body goes if it is stored in S3 ({@link bodyKey}). */
  readonly key: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  /** {@link estimateRowBytes} of the row this body will be stored on, without the body. */
  readonly otherRowBytes: number;
}

/**
 * Cap a body to what the reader can show, then store it inline or in S3, and return the row's
 * pointer. A message with no text or HTML part (attachments only) gets an EMPTY inline body,
 * so it is never mistaken for a legacy row that predates stored bodies. The S3 write happens
 * BEFORE the caller writes the row (the row is the commit marker), so a row never points at a
 * missing object.
 */
export async function storeEmailBody(
  store: MailBodyStore,
  input: StoreEmailBodyInput,
): Promise<StoredEmailBody> {
  // The same per-part cap the reader applied when it re-parsed raw MIME, so what is stored is
  // exactly what used to be shown. The response budget is re-applied at read time, when the
  // envelope's size is known.
  const fitted = fitBodyToBudget(input.text, input.html, {
    partCapBytes: MAX_READ_BODY_BYTES,
    serializedBudgetBytes: MAX_EMAIL_RESPONSE_BYTES,
  });
  const content: MailBodyContent = {
    ...(fitted.text !== undefined ? { text: fitted.text } : {}),
    ...(fitted.html !== undefined ? { html: fitted.html } : {}),
    ...(fitted.truncated ? { truncated: true } : {}),
  };
  const bodyBytes = utf8Bytes(content.text) + utf8Bytes(content.html);
  if (
    bodyBytes <= MAX_INLINE_BODY_BYTES &&
    input.otherRowBytes + bodyBytes <= MAX_INLINE_ROW_BYTES
  ) {
    return { kind: 'inline', ...content };
  }
  await store.putBody(input.key, content);
  return { kind: 's3', s3Key: input.key };
}

/**
 * Read a stored body back; null when its S3 object is missing or the stored pointer is not one
 * this code wrote. An inline body is re-checked field by field, like the S3 JSON.
 */
export async function loadEmailBody(
  store: MailBodyStore,
  body: StoredEmailBody,
): Promise<MailBodyContent | null> {
  if (body.kind === 's3') {
    return typeof body.s3Key === 'string' ? store.getBody(body.s3Key) : null;
  }
  if (body.kind !== 'inline') {
    return null;
  }
  return {
    ...(typeof body.text === 'string' ? { text: body.text } : {}),
    ...(typeof body.html === 'string' ? { html: body.html } : {}),
    ...(body.truncated === true ? { truncated: true } : {}),
  };
}

function utf8Bytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}
