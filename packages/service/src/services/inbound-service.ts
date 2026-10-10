/**
 * Orchestrates one inbound message: validate the event key → HEAD (size gate +
 * trusted receipt time) → stream-parse (attachments to S3) → store the decoded body (inline
 * or S3), or — when content can't be extracted — copy the raw MIME into quarantine →
 * conditional-put the DDB row as the final commit marker (under FAILED for the latter). Everything is behind
 * injected ports (S3 object store, body store, emails repo) so the whole flow is testable
 * with fakes and no AWS.
 *
 * Ordering guarantees idempotency + no partial publish: attachments and a large body are
 * written to deterministic keys FIRST, then the row is conditionally put last. A redelivery
 * overwrites the same attachment objects and finds the row present (no-op). A handled
 * failure (bad key / oversize / malformed / over-limit) writes a bounded
 * quarantine/parse-status row with NO attachment descriptors — so any objects written
 * during the failed attempt are unreachable (the row is the only key source the read
 * API serves) — and best-effort deletes them. Only an infra failure (S3/DDB) throws,
 * so the async invocation retries and eventually DLQs.
 *
 * SES's raw copy is tagged for expiry only AFTER the row is committed — by then the body is
 * stored, or (for a message whose content can't be extracted) the raw MIME is copied into
 * quarantine. A message that never gets a row (its ingest dead-lettered) keeps its raw copy
 * indefinitely: it is the only copy of that message.
 *
 * A readable message that links this deployment's own download links (`/d/{token}`) — a file
 * one of your addresses sent another — also carries each linked file as an attachment, pointing
 * at the sent copy (see {@link OwnLinkAttachments}).
 */
import { Readable } from 'node:stream';
import type {
  EmailsDao,
  CreateInboundEmailInput,
  InboundAttachmentDescriptor,
  InboundVerdict,
} from '../data/emails-dao.js';
import type { InboundObjectStore } from '../facades/s3-inbound-object-store.js';
import type { MailBodyStore } from '../facades/s3-mail-body-store.js';
import type { OwnLinkAttachments } from './own-link-attachments.js';
import type { QuarantineStore } from '../facades/s3-quarantine-store.js';
import { validateInboundEventKey } from '../utils/event-key.js';
import { rootHeaderBlock } from '../utils/inbound-headers.js';
import { MAX_HEADER_BLOCK_BYTES, MAX_RAW_MESSAGE_BYTES } from '../utils/inbound-limits.js';
import { parseInbound, type AttachmentSink, type ParsedInbound } from '../utils/inbound-parse.js';
import {
  sanitizeContentType,
  sanitizeFilename,
  snippetFromHtml,
  snippetFromText,
} from '../utils/sanitize.js';
import { decideExposure, type Exposure } from '../utils/verdicts.js';
import { bodyKey, estimateRowBytes, storeEmailBody } from './email-body-storage.js';

/** Extracted attachments live OUTSIDE the `inbound/` trigger prefix so writes never re-invoke the parser. */
export const ATTACHMENTS_PREFIX = 'attachments/inbound/';

export type ProcessOutcome = 'indexed' | 'quarantined' | 'duplicate' | 'skipped';

export interface ProcessInboundServiceRequest {
  /** The still-URL-encoded S3 object key from the event record. Validated before any read. */
  readonly rawKey: string;
}

export interface ProcessInboundServiceResponse {
  readonly outcome: ProcessOutcome;
  readonly messageId?: string;
  readonly reason?: string;
}

/** Where an Errors-folder message's raw MIME is kept in the quarantine bucket. */
export function quarantineKey(messageId: string): string {
  return `inbound/${messageId}.eml`;
}

/** The header-only parse has no body, so it never sees an attachment; answer defensively. */
const NO_ATTACHMENTS: AttachmentSink = {
  store: (partIndex, filename, contentType, bytes) =>
    Promise.resolve({
      id: String(partIndex),
      filename: filename ?? '',
      contentType,
      sizeBytes: bytes.length,
      s3Key: '',
    }),
};

const ABSENT_VERDICTS = {
  spamVerdict: 'ABSENT' as InboundVerdict,
  virusVerdict: 'ABSENT' as InboundVerdict,
};

export class InboundProcessor {
  constructor(
    private readonly store: InboundObjectStore,
    private readonly emails: EmailsDao,
    private readonly bodies: MailBodyStore,
    private readonly quarantine: QuarantineStore,
    /** Absent → links stay links (no attachment is added for them). */
    private readonly ownLinks?: OwnLinkAttachments,
  ) {}

  /** Process the object identified by a raw (still-encoded) S3 event key. */
  async process(request: ProcessInboundServiceRequest): Promise<ProcessInboundServiceResponse> {
    const key = validateInboundEventKey(request.rawKey);
    if (!key.ok) {
      // No validated stable id → cannot write a keyed row. Log-and-succeed (no retry).
      return { outcome: 'skipped', reason: key.reason };
    }
    const head = await this.store.head(key.rawS3Key);
    if (!head) {
      return { outcome: 'skipped', reason: 'object not found', messageId: key.messageId };
    }
    const receivedAt = head.lastModified.toISOString();
    const base = {
      messageId: key.messageId,
      receivedAt,
      rawS3Key: key.rawS3Key,
      sizeBytes: head.sizeBytes,
    };

    // Size gate BEFORE download — never fetch an over-cap object. Read only its header block,
    // so the Errors folder still shows its sender, subject, and SES's real verdicts.
    if (head.sizeBytes > MAX_RAW_MESSAGE_BYTES) {
      const headerOnly = await this.parseHeaderBlock(key.rawS3Key);
      return this.finish(base, { ...headerOnly, parseStatus: 'oversize' });
    }

    const writtenKeys: string[] = [];
    const sink: AttachmentSink = {
      store: async (partIndex, filename, contentType, bytes) => {
        const s3Key = `${ATTACHMENTS_PREFIX}${key.messageId}/${partIndex}`;
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

    const stream = await this.store.getStream(key.rawS3Key);
    const parsed = await parseInbound(stream, sink); // rejects only on infra → caller retries

    if (parsed.parseStatus !== 'ok') {
      // Handled failure: the row will carry no attachment descriptors, so anything
      // written this attempt is unreachable — best-effort delete it anyway.
      await this.cleanup(writtenKeys);
    }
    return this.finish(base, parsed);
  }

  /**
   * Store what the message needs, then write its row. Exposable content gets its body stored
   * (inline or S3), exactly like the snippet and attachments. Anything else — a virus verdict
   * other than PASS, or a parse failure / limit breach — keeps nothing readable: its raw MIME
   * is copied into quarantine and the row goes to the Errors folder. Both writes land on
   * deterministic keys BEFORE the row, so a redelivery only overwrites them; SES's raw copy is
   * tagged for expiry only after the row is committed.
   */
  private async finish(
    base: RecordBase,
    parsed: ParsedInbound,
  ): Promise<ProcessInboundServiceResponse> {
    const exposure = decideExposure(parsed.verdicts, parsed.parseStatus);
    const linked = await this.linkedAttachments(base, parsed, exposure);
    const record = this.record(base, parsed, exposure, linked);
    let response: ProcessInboundServiceResponse;
    if (exposure.exposeContent) {
      // Store the body exactly like the snippet and attachments — only for exposable content —
      // sized against the rest of the row so an inline body can't push it past DynamoDB's limit.
      const body = await storeEmailBody(this.bodies, {
        key: bodyKey('inbound', base.messageId),
        text: parsed.textBody,
        html: parsed.htmlBody,
        otherRowBytes: estimateRowBytes(record),
      });
      response = await this.commit({ ...record, body }, base.messageId);
    } else {
      // Nothing readable is kept (virus / parse failure): keep the raw MIME in quarantine —
      // the only way to recover the message later — and file the row in the Errors folder.
      const quarantineS3Key = quarantineKey(base.messageId);
      await this.quarantine.copyFromMail(base.rawS3Key, quarantineS3Key);
      response = await this.commit({ ...record, failed: true, quarantineS3Key }, base.messageId);
    }
    // Committed (or already committed, on a redelivery), and everything worth keeping is stored
    // elsewhere: SES's raw copy is now only the short-lived `.eml` source, so let it expire.
    await this.store.markIngested(base.rawS3Key);
    return response;
  }

  /**
   * An over-cap message's metadata from its header block alone (a ranged read, never the whole
   * object): run through the same parser as any message, with no body, so the sender, subject,
   * and verdicts get the same decoding and fail-closed rules. A header block that runs past
   * the bytes read yields only ABSENT verdicts.
   */
  private async parseHeaderBlock(rawS3Key: string): Promise<ParsedInbound> {
    const block = rootHeaderBlock(await this.store.getHead(rawS3Key, MAX_HEADER_BLOCK_BYTES));
    if (block === undefined) {
      return {
        parseStatus: 'oversize',
        from: '',
        to: [],
        cc: [],
        subject: '',
        verdicts: ABSENT_VERDICTS,
        exposed: false,
        attachmentCount: 0,
        attachments: [],
      };
    }
    const parsed = await parseInbound(
      Readable.from([Buffer.concat([block, Buffer.from('\r\n\r\n')])]),
      NO_ATTACHMENTS,
    );
    // Only the header metadata is meaningful — nothing past the headers was read.
    return { ...parsed, exposed: false, attachmentCount: 0, attachments: [] };
  }

  /**
   * Files this message links from this deployment's own sends, as attachments — only for mail
   * that is readable and not flagged as spam: anything else keeps its links as plain links.
   */
  private async linkedAttachments(
    base: RecordBase,
    parsed: ParsedInbound,
    exposure: Exposure,
  ): Promise<InboundAttachmentDescriptor[]> {
    if (this.ownLinks === undefined || !exposure.exposeContent || exposure.quarantined) {
      return [];
    }
    const resolved = await this.ownLinks.resolve({
      bodies: [parsed.textBody, parsed.htmlBody],
      from: parsed.from,
      authenticatedDomain: parsed.dmarcPassDomain,
      receivedAt: base.receivedAt,
    });
    return [...resolved.attachments];
  }

  /** Conditional-put the row (the commit marker) and map the outcome. */
  private async commit(
    record: CreateInboundEmailInput,
    messageId: string,
  ): Promise<ProcessInboundServiceResponse> {
    const result = await this.emails.createInboundEmail(record);
    if (!result.created) {
      return { outcome: 'duplicate', messageId };
    }
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

  private record(
    base: RecordBase,
    parsed: ParsedInbound,
    exposure: Exposure,
    linked: readonly InboundAttachmentDescriptor[],
  ): CreateInboundEmailInput {
    const snippet = exposure.exposeContent ? this.snippet(parsed) : undefined;
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
      hasAttachments: parsed.attachmentCount + linked.length > 0,
      attachmentCount: parsed.attachmentCount + linked.length,
      attachments: exposure.exposeContent ? [...parsed.attachments, ...linked] : [],
      spamVerdict: parsed.verdicts.spamVerdict,
      virusVerdict: parsed.verdicts.virusVerdict,
      parseStatus: parsed.parseStatus,
      quarantined: exposure.quarantined,
      rawS3Key: base.rawS3Key,
      sizeBytes: base.sizeBytes,
    };
  }

  private snippet(parsed: ParsedInbound): string {
    const fromText = snippetFromText(parsed.textBody);
    if (fromText) {
      return fromText;
    }
    return snippetFromHtml(parsed.htmlBody);
  }
}

interface RecordBase {
  readonly messageId: string;
  readonly receivedAt: string;
  readonly rawS3Key: string;
  readonly sizeBytes: number;
}
