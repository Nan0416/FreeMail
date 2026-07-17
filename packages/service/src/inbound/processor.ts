/**
 * Orchestrates one inbound message: validate the event key → HEAD (size gate +
 * trusted receipt time) → stream-parse (attachments to S3) → conditional-put the DDB
 * row as the final commit marker. Everything is behind injected ports (S3 object
 * store + emails repo) so the whole flow is testable with fakes and no AWS.
 *
 * Ordering guarantees idempotency + no partial publish: attachments are written to
 * deterministic keys FIRST, then the row is conditionally put last. A redelivery
 * overwrites the same attachment objects and finds the row present (no-op). A handled
 * failure (bad key / oversize / malformed / over-limit) writes a bounded
 * quarantine/parse-status row with NO attachment descriptors — so any objects written
 * during the failed attempt are unreachable (the row is the only key source the read
 * API serves) — and best-effort deletes them. Only an infra failure (S3/DDB) throws,
 * so the async invocation retries and eventually DLQs.
 */
import type { EmailsRepo, InboundEmailRecord, InboundVerdict } from '../data/emails-repo.js';
import type { InboundObjectStore } from '../data/inbound-object-store.js';
import { validateInboundEventKey } from './event-key.js';
import { MAX_RAW_MESSAGE_BYTES } from './limits.js';
import { parseInbound, type AttachmentSink, type ParsedInbound } from './parse.js';
import {
  sanitizeContentType,
  sanitizeFilename,
  snippetFromHtml,
  snippetFromText,
} from './sanitize.js';
import { decideExposure } from './verdicts.js';

/** Extracted attachments live OUTSIDE the `inbound/` trigger prefix so writes never re-invoke the parser. */
export const ATTACHMENTS_PREFIX = 'attachments/inbound/';

export type ProcessOutcome = 'indexed' | 'quarantined' | 'duplicate' | 'skipped';

export interface ProcessResult {
  outcome: ProcessOutcome;
  messageId?: string;
  reason?: string;
}

const ABSENT_VERDICTS = {
  spamVerdict: 'ABSENT' as InboundVerdict,
  virusVerdict: 'ABSENT' as InboundVerdict,
};

export class InboundProcessor {
  constructor(
    private readonly store: InboundObjectStore,
    private readonly emails: EmailsRepo,
  ) {}

  /** Process the object identified by a raw (still-encoded) S3 event key. */
  async process(rawKey: string): Promise<ProcessResult> {
    const key = validateInboundEventKey(rawKey);
    if (!key.ok) {
      // No validated stable id → cannot write a keyed row. Log-and-succeed (no retry).
      return { outcome: 'skipped', reason: key.reason };
    }
    const { messageId, rawS3Key } = key;

    const head = await this.store.head(rawS3Key);
    if (!head) {
      return { outcome: 'skipped', reason: 'object not found', messageId };
    }
    const receivedAt = head.lastModified.toISOString();
    const base = { messageId, receivedAt, rawS3Key, sizeBytes: head.sizeBytes };

    // Size gate BEFORE download — never fetch an over-cap object.
    if (head.sizeBytes > MAX_RAW_MESSAGE_BYTES) {
      return this.commit(this.oversizeRecord(base), messageId);
    }

    const writtenKeys: string[] = [];
    const sink: AttachmentSink = {
      store: async (partIndex, filename, contentType, bytes) => {
        const s3Key = `${ATTACHMENTS_PREFIX}${messageId}/${partIndex}`;
        await this.store.putAttachment(s3Key, bytes);
        writtenKeys.push(s3Key);
        return {
          id: String(partIndex),
          filename: sanitizeFilename(filename),
          contentType: sanitizeContentType(contentType),
          sizeBytes: bytes.length,
          s3Key,
        };
      },
    };

    const stream = await this.store.getStream(rawS3Key);
    const parsed = await parseInbound(stream, sink); // rejects only on infra → caller retries

    if (parsed.parseStatus !== 'ok') {
      // Handled failure: the row will carry no attachment descriptors, so anything
      // written this attempt is unreachable — best-effort delete it anyway.
      await this.cleanup(writtenKeys);
    }
    return this.commit(this.record(base, parsed), messageId);
  }

  /** Conditional-put the row (the commit marker) and map the outcome. */
  private async commit(record: InboundEmailRecord, messageId: string): Promise<ProcessResult> {
    const written = await this.emails.putInbound(record);
    if (!written) return { outcome: 'duplicate', messageId };
    return { outcome: record.quarantined ? 'quarantined' : 'indexed', messageId };
  }

  private async cleanup(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((k) =>
        this.store.deleteObject(k).catch(() => {
          // best-effort — the row references none of these, so they're already unreachable
        }),
      ),
    );
  }

  private oversizeRecord(base: RecordBase): InboundEmailRecord {
    const { quarantined } = decideExposure(ABSENT_VERDICTS, 'oversize');
    return {
      id: base.messageId,
      sesMessageId: base.messageId,
      from: '',
      to: [],
      cc: [],
      subject: '',
      receivedAt: base.receivedAt,
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      spamVerdict: ABSENT_VERDICTS.spamVerdict,
      virusVerdict: ABSENT_VERDICTS.virusVerdict,
      parseStatus: 'oversize',
      quarantined,
      rawS3Key: base.rawS3Key,
      sizeBytes: base.sizeBytes,
    };
  }

  private record(base: RecordBase, parsed: ParsedInbound): InboundEmailRecord {
    const { exposeContent, quarantined } = decideExposure(parsed.verdicts, parsed.parseStatus);
    const snippet = exposeContent ? this.snippet(parsed) : undefined;
    return {
      id: base.messageId,
      sesMessageId: base.messageId,
      from: parsed.from,
      fromName: parsed.fromName,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      snippet: snippet || undefined,
      receivedAt: base.receivedAt,
      headerDate: parsed.headerDate,
      hasAttachments: parsed.attachmentCount > 0,
      attachmentCount: parsed.attachmentCount,
      attachments: exposeContent ? parsed.attachments : [],
      spamVerdict: parsed.verdicts.spamVerdict,
      virusVerdict: parsed.verdicts.virusVerdict,
      parseStatus: parsed.parseStatus,
      quarantined,
      rawS3Key: base.rawS3Key,
      sizeBytes: base.sizeBytes,
    };
  }

  private snippet(parsed: ParsedInbound): string {
    const fromText = snippetFromText(parsed.textBody);
    if (fromText) return fromText;
    return snippetFromHtml(parsed.htmlBody);
  }
}

interface RecordBase {
  messageId: string;
  receivedAt: string;
  rawS3Key: string;
  sizeBytes: number;
}
