/**
 * Hard limits for parsing INBOUND mail — attacker-controlled MIME. Every one of
 * these bounds a resource an inbound message could try to exhaust (memory, S3
 * objects, DDB item size, Lambda time). A breach never throws to the caller as a
 * retryable error: the processor records a bounded quarantined/parse-status row
 * and returns success, so a hostile message can't drive an infinite retry.
 *
 * Peak memory bound: the pre-download raw-size gate ({@link MAX_RAW_MESSAGE_BYTES})
 * caps the whole message; only one attachment is buffered at a time (streamed to
 * S3 and released before the next), each ≤ {@link MAX_ATTACHMENT_BYTES}. The Lambda
 * is sized above that bound (see the infra construct).
 */

/** Skip (never even download) a raw object larger than this — SES caps received mail near 40 MB. */
export const MAX_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;

/** Only the leading header block is scanned for SES verdict lines; cap how much we buffer for it. */
export const MAX_HEADER_BLOCK_BYTES = 256 * 1024;

/** Max MIME parts (text + attachment nodes) we process before treating the message as hostile. */
export const MAX_MIME_PARTS = 200;

/** Max attachments extracted to S3 from one message. */
export const MAX_ATTACHMENTS = 25;

/** Max decoded bytes for a single attachment. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Max total decoded bytes across all extracted attachments. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 30 * 1024 * 1024;

/** Subject is capped before storage (attacker can send a megabyte "subject"). */
export const MAX_SUBJECT_CHARS = 998;

/** Stored snippet length — a short preview, always safe plain text. */
export const MAX_SNIPPET_CHARS = 300;

/** Max HTML input fed to the snippet parser — bounds the parser work itself, not just its output. */
export const MAX_HTML_SNIPPET_INPUT_BYTES = 512 * 1024;

/** Max addresses retained per header (to/cc); extras are dropped. */
export const MAX_ADDRESSES_PER_HEADER = 50;

/** Max stored length of a single address or display name. */
export const MAX_ADDRESS_CHARS = 320;

/** Max stored length of an attachment's (display-only) filename. */
export const MAX_FILENAME_CHARS = 255;
