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
 * How long SES's raw inbound MIME (`inbound/<id>`) is kept once ingest has fully extracted the
 * message (body + attachments) — then it only backs the "Download original" `.eml`, which is
 * therefore offered only for mail younger than this. The mail bucket's lifecycle rule expires
 * such objects after the same number of days. S3 never deletes an object before then (it rounds
 * up to the next midnight UTC and lags further), so a download offered inside the window finds
 * its object in practice.
 */
export const INBOUND_RAW_RETENTION_DAYS = 14;

/**
 * The S3 object tag the inbound parser sets on `inbound/<id>` after committing the row of a
 * message whose content it FULLY extracted. The lifecycle rule expires only tagged objects, so
 * raw MIME that is still the only copy of something — a message that failed to parse, one that
 * never got a row (its ingest dead-lettered), anything stored before tagging existed — is kept.
 */
export const INBOUND_INGESTED_TAG = { key: 'freemail-ingested', value: 'true' } as const;
