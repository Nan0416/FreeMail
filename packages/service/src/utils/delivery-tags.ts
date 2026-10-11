/**
 * The SES message tags a send carries so its delivery reports can find its row: SES copies a
 * message's tags into every event it publishes about it. The row is keyed by its id and send
 * time; tag values allow only letters, digits, `_`, and `-`, so the time travels as epoch
 * milliseconds rather than the ISO string.
 */

/** Tag names. */
export const DELIVERY_TAG_ID = 'freemail-id';
export const DELIVERY_TAG_SENT = 'freemail-sent';

/** The tags for the sent row `id`, sent at `sentAt`. */
export function deliveryTags(id: string, sentAt: Date): Record<string, string> {
  return { [DELIVERY_TAG_ID]: id, [DELIVERY_TAG_SENT]: String(sentAt.getTime()) };
}
