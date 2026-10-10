/**
 * Storage schema shared by the CDK app (which creates it) and the service (which queries it),
 * so a name or attribute list is spelled exactly once.
 *
 * Deliberately NOT re-exported from the package barrel: the SPA never touches storage.
 * Import it as `@freemail/shared/storage`.
 */

/**
 * The emails table's list index. Same keys as the table (`pk` = partition, `sk` =
 * `<iso>#<id>`), so a descending Query on it is the same newest-first timeline, and a cursor
 * sk resumes it exactly as it would the table.
 */
export const EMAIL_LIST_INDEX_NAME = 'list';

/**
 * The non-key attributes projected into {@link EMAIL_LIST_INDEX_NAME}: exactly the fields the
 * mailbox list renders, plus `parseStatus` for the Errors folder.
 *
 * DynamoDB charges and size-caps a query on an index by these projected entries, not by the
 * full items, so a list page stays small however large the stored bodies and attachment
 * descriptors get. Keep bodies, descriptors, and S3 pointers OUT of this list.
 *
 * Changing it is a migration, not an edit: CloudFormation cannot change a GSI's projection in
 * place, so adding a field means creating a new index, switching reads to it, then dropping
 * the old one (one GSI create/delete per deploy).
 */
export const EMAIL_LIST_INDEX_ATTRIBUTES = [
  'direction',
  'id',
  'from',
  'fromName',
  'to',
  'cc',
  'subject',
  'snippet',
  'sentAt',
  'receivedAt',
  'status',
  'hasAttachments',
  'attachmentCount',
  'quarantined',
  'spamVerdict',
  'virusVerdict',
  'parseStatus',
] as const;

/** One attribute projected into the list index. */
export type EmailListIndexAttribute = (typeof EMAIL_LIST_INDEX_ATTRIBUTES)[number];

/**
 * How long SES's raw inbound MIME (`inbound/<id>`) is kept. Ingest extracts everything the
 * reader needs (body, attachments), so the raw object is only staging plus the source of the
 * "Download original" `.eml` — which is therefore offered only for mail younger than this.
 * The mail bucket's lifecycle rule expires the prefix after the same number of days; S3 never
 * deletes an object before then (it rounds up to the next midnight UTC and may lag), so a
 * download offered inside the window always finds its object.
 */
export const INBOUND_RAW_RETENTION_DAYS = 14;
