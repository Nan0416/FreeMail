/**
 * The read side of the mailbox: list the merged sent/inbound timeline, read one message,
 * and mint a presigned download URL for one attachment. Injectable (repo + presigner +
 * raw-MIME source + clock + parser) so every branch is testable without AWS, and so #13's
 * MCP read tools can reuse this exact service — the REST routes are thin adapters, mirroring
 * how #6's send route and #7's MCP tool share one {@link EmailService}.
 *
 * Bodies: the DDB index stores only a snippet, so a received message's full body is
 * materialized on demand by re-parsing its raw MIME through #10's `parseInbound` (with a
 * no-op attachment sink) — inheriting ALL of #10's untrusted-MIME hardening (node/body/size
 * caps). We only re-parse rows the stored verdicts already mark exposable (fail-closed via
 * the same `decideExposure` gate), so a quarantined message never re-parses and never
 * yields a body. Sent messages have no stored body source, so their detail is envelope-only.
 * HTML is returned RAW as data — the client owns safe rendering (#12).
 */
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_URL_TTL_SECONDS,
  type AttachmentDownloadResponse,
  type EmailAttachmentInfo,
  type EmailDetail,
  type EmailListItem,
  type ListEmailsResponse,
  MAX_EMAIL_RESPONSE_BYTES,
  MAX_READ_BODY_BYTES,
} from '@freemail/shared';
import {
  type EmailsReadRepo,
  INBOUND_PARTITION,
  SENT_PARTITION,
  type StoredEmailRow,
} from '../data/emails-repo.js';
import type { AttachmentPresigner } from '../data/s3-attachment-presigner.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_HEADER_BLOCK_BYTES,
  MAX_HTML_BODY_BYTES,
  MAX_MIME_PARTS,
  MAX_RAW_MESSAGE_BYTES,
  MAX_TEXT_BODY_BYTES,
  MAX_TOTAL_BODY_BYTES,
} from '../inbound/limits.js';
import {
  type AttachmentSink,
  type ParsedInbound,
  type ParseLimits,
  parseInbound,
} from '../inbound/parse.js';
import { decideExposure } from '../inbound/verdicts.js';
import { fitBodyToBudget } from './body-budget.js';
import { contentDispositionForDownload } from './content-disposition.js';
import { decodeEmailRef, encodeEmailRef } from './email-ref.js';
import { emailErrors } from './errors.js';
import { listEmailsPage } from './list-merge.js';

/** The raw-MIME source the reader re-parses bodies from — satisfied by the inbound S3 store. */
export interface RawMimeSource {
  getStream(key: string): Promise<Readable>;
}

/** The parse function — defaulted to #10's `parseInbound`, overridable in tests. */
export type ParseInbound = (
  source: Readable,
  sink: AttachmentSink,
  limits?: ParseLimits,
) => Promise<ParsedInbound>;

export interface EmailReadServiceDeps {
  emails: EmailsReadRepo;
  presigner: AttachmentPresigner;
  rawMime: RawMimeSource;
  now?: () => Date;
  parse?: ParseInbound;
}

export interface ListEmailsQuery {
  direction?: 'sent' | 'inbound';
  limit: number;
  cursor?: string;
}

/**
 * Read limits for on-demand body materialization: identical to #10's parse limits (so the
 * exposure decision can't drift) EXCEPT we retain more of the body — up to the per-part read
 * cap — instead of only a snippet-sized slice. Typed as `ParseLimits`, so if #10 adds a limit
 * field this fails to compile until updated (no silent drift).
 */
const READ_PARSE_LIMITS: ParseLimits = {
  maxRawBytes: MAX_RAW_MESSAGE_BYTES,
  maxChildNodes: MAX_MIME_PARTS,
  maxHeadSize: MAX_HEADER_BLOCK_BYTES,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxAttachmentTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
  maxTextBodyBytes: MAX_TEXT_BODY_BYTES,
  maxHtmlBodyBytes: MAX_HTML_BODY_BYTES,
  maxTotalBodyBytes: MAX_TOTAL_BODY_BYTES,
  maxSnippetSourceBytes: MAX_READ_BODY_BYTES,
};

/** A no-op attachment sink: the reader re-parses only for the body, never re-storing attachments. */
const NOOP_SINK: AttachmentSink = {
  store: (partIndex, filename, contentType, bytes) =>
    Promise.resolve({
      id: String(partIndex),
      filename: filename ?? '',
      contentType,
      sizeBytes: bytes.length,
      s3Key: '',
    }),
};

function refForRow(row: StoredEmailRow): { pk: string; sk: string } {
  return {
    pk: row.direction === 'inbound' ? INBOUND_PARTITION : SENT_PARTITION,
    sk: row.sk,
  };
}

export class EmailReadService {
  private readonly emails: EmailsReadRepo;
  private readonly presigner: AttachmentPresigner;
  private readonly rawMime: RawMimeSource;
  private readonly now: () => Date;
  private readonly parse: ParseInbound;

  constructor(deps: EmailReadServiceDeps) {
    this.emails = deps.emails;
    this.presigner = deps.presigner;
    this.rawMime = deps.rawMime;
    this.now = deps.now ?? (() => new Date());
    this.parse = deps.parse ?? parseInbound;
  }

  /** List the merged (or direction-filtered) timeline, newest-first, one opaque-cursor page. */
  async listEmails(query: ListEmailsQuery): Promise<ListEmailsResponse> {
    const page = await listEmailsPage({
      query: (direction, opts) => this.emails.queryDirection(direction, opts),
      ...(query.direction ? { direction: query.direction } : {}),
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return {
      emails: page.rows.map((row) => this.toListItem(row)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /** Read one message. Received + exposable → body materialized; otherwise envelope-only. */
  async getEmail(handle: string): Promise<EmailDetail> {
    const row = await this.loadRow(handle);
    // Size the envelope first so the body budget accounts for the WHOLE response, not just
    // the body — the combined serialized bytes must stay under the Lambda response limit.
    const envelopeBytes = Buffer.byteLength(JSON.stringify(this.toDetail(row, handle, {})), 'utf8');
    const body = await this.materializeBody(row, envelopeBytes);
    return this.toDetail(row, handle, body);
  }

  /**
   * Mint a presigned download URL for one attachment. Only descriptors actually on the row
   * are addressable — a quarantined/virus/parse-failed message has none, so the id resolves
   * to nothing → 404, never a guessable key. The raw S3 key is used server-side only.
   */
  async getAttachmentUrl(
    handle: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadResponse> {
    const row = await this.loadRow(handle);
    const descriptor =
      row.direction === 'inbound' ? row.attachments.find((a) => a.id === attachmentId) : undefined;
    if (!descriptor) {
      throw emailErrors.notFound('No such attachment.');
    }
    const url = await this.presigner.presign({
      key: descriptor.s3Key,
      // Force a non-inline download regardless of the object's stored metadata.
      contentType: 'application/octet-stream',
      contentDisposition: contentDispositionForDownload(descriptor.filename),
      expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    });
    const expiresAt = new Date(
      this.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000,
    ).toISOString();
    return { url, expiresAt };
  }

  private async loadRow(handle: string): Promise<StoredEmailRow> {
    const ref = decodeEmailRef(handle);
    const row = await this.emails.getByKey(ref);
    if (!row) {
      throw emailErrors.notFound('No such message.');
    }
    return row;
  }

  /** Re-parse the raw MIME for a received, exposable message's body; `{}` otherwise. */
  private async materializeBody(
    row: StoredEmailRow,
    envelopeBytes: number,
  ): Promise<{ text?: string; html?: string; bodyTruncated?: boolean }> {
    if (row.direction !== 'inbound') {
      return {};
    }
    // Gate on the STORED verdicts first — a non-exposable row is never re-parsed.
    const exposure = decideExposure(
      { spamVerdict: row.spamVerdict, virusVerdict: row.virusVerdict },
      row.parseStatus,
    );
    if (!exposure.exposeContent) {
      return {};
    }
    const stream = await this.rawMime.getStream(row.rawS3Key);
    const parsed = await this.parse(stream, NOOP_SINK, READ_PARSE_LIMITS);
    // Defense in depth: if the re-parse disagrees (shouldn't), fail closed to no body.
    if (!parsed.exposed) {
      return {};
    }
    // Bound the returned body in real UTF-8 bytes (the parser retains by char count) and
    // hard-cap the JSON-escaped payload so a hostile body can't exceed the Lambda response
    // budget — combined with the already-measured envelope. See fitBodyToBudget.
    const fitted = fitBodyToBudget(parsed.textBody, parsed.htmlBody, {
      partCapBytes: MAX_READ_BODY_BYTES,
      serializedBudgetBytes: Math.max(0, MAX_EMAIL_RESPONSE_BYTES - envelopeBytes),
    });
    return {
      ...(fitted.text !== undefined ? { text: fitted.text } : {}),
      ...(fitted.html !== undefined ? { html: fitted.html } : {}),
      ...(fitted.truncated ? { bodyTruncated: true } : {}),
    };
  }

  private toListItem(row: StoredEmailRow): EmailListItem {
    const id = encodeEmailRef(refForRow(row));
    if (row.direction === 'sent') {
      return {
        id,
        direction: 'sent',
        from: row.from,
        to: row.to,
        cc: row.cc,
        subject: row.subject,
        date: row.sentAt,
        hasAttachments: row.attachmentCount > 0,
        attachmentCount: row.attachmentCount,
      };
    }
    return {
      id,
      direction: 'inbound',
      from: row.from,
      ...(row.fromName !== undefined ? { fromName: row.fromName } : {}),
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
      date: row.receivedAt,
      hasAttachments: row.hasAttachments,
      attachmentCount: row.attachmentCount,
      quarantined: row.quarantined,
      spamVerdict: row.spamVerdict,
      virusVerdict: row.virusVerdict,
    };
  }

  private toDetail(
    row: StoredEmailRow,
    handle: string,
    body: { text?: string; html?: string; bodyTruncated?: boolean },
  ): EmailDetail {
    if (row.direction === 'sent') {
      return {
        id: handle,
        direction: 'sent',
        from: row.from,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        subject: row.subject,
        date: row.sentAt,
        attachments: [],
        hasAttachments: row.attachmentCount > 0,
        attachmentCount: row.attachmentCount,
        sizeBytes: row.sizeBytes,
      };
    }
    return {
      id: handle,
      direction: 'inbound',
      from: row.from,
      ...(row.fromName !== undefined ? { fromName: row.fromName } : {}),
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      date: row.receivedAt,
      ...(row.headerDate !== undefined ? { headerDate: row.headerDate } : {}),
      ...body,
      attachments: row.attachments.map(publicDescriptor),
      hasAttachments: row.hasAttachments,
      attachmentCount: row.attachmentCount,
      quarantined: row.quarantined,
      spamVerdict: row.spamVerdict,
      virusVerdict: row.virusVerdict,
      parseStatus: row.parseStatus,
      sizeBytes: row.sizeBytes,
    };
  }
}

/** Strip the server-only S3 key — the client gets only the addressable attachment id. */
function publicDescriptor(descriptor: {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): EmailAttachmentInfo {
  return {
    id: descriptor.id,
    filename: descriptor.filename,
    contentType: descriptor.contentType,
    sizeBytes: descriptor.sizeBytes,
  };
}
