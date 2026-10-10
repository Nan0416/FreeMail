/**
 * Turn this deployment's own download links in a received message into real attachments.
 *
 * A large file goes out as a `/d/{token}` link, which an outside recipient can use for the
 * token's lifetime. When the recipient is one of this deployment's own addresses, the message
 * comes straight back in through inbound — so the received copy recognizes its own links and
 * records each linked file as an attachment on its row, pointing at the sent message's
 * permanent copy (`attachments/sent/<id>/<n>`). There it never expires and opens like any
 * other attachment. No bytes are copied, and the download link in the body is left as is.
 *
 * A link counts only when its token says so: it exists and is live, its message was sent to
 * at least one of this deployment's own addresses, and by the same address this message is
 * from. A link pasted into anyone else's mail stays just a link.
 */
import type { DownloadTokensDao, GetDownloadTokenOutput } from '../data/download-tokens-dao.js';
import type { InboundAttachmentDescriptor } from '../data/emails-dao.js';
import { isValidDownloadToken } from '../utils/download-token.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('OwnLinkAttachments');

/** At most this many links are looked up per message (a send carries at most 20 files). */
export const MAX_LINKED_ATTACHMENTS = 20;

/** Every linked file is a copy a send stored; a row is never pointed anywhere else. */
const SENT_ATTACHMENTS_PREFIX = 'attachments/sent/';

export interface ResolveLinkedAttachmentsInput {
  /** The message's decoded text and HTML bodies (either may be absent). */
  readonly bodies: readonly (string | undefined)[];
  /** The message's From address. */
  readonly from: string;
  /** When it was received (ISO-8601 UTC); a token must still be live then. */
  readonly receivedAt: string;
}

export class OwnLinkAttachments {
  private readonly linkPattern: RegExp;

  /** `downloadBaseUrl` is the API's public base, exactly as the send path builds links. */
  constructor(
    private readonly tokens: DownloadTokensDao,
    downloadBaseUrl: string,
  ) {
    const base = escapeRegExp(downloadBaseUrl.replace(/\/+$/, ''));
    // Host and scheme match case-insensitively; the token itself is matched exactly below.
    this.linkPattern = new RegExp(`${base}/d/([A-Za-z0-9_-]+)`, 'gi');
  }

  /**
   * The linked files this message may carry as attachments, in the order their links appear.
   * Best-effort: a lookup that fails is logged and skipped — the link itself still works.
   */
  async resolve(input: ResolveLinkedAttachmentsInput): Promise<InboundAttachmentDescriptor[]> {
    const from = input.from.trim().toLowerCase();
    const descriptors: InboundAttachmentDescriptor[] = [];
    const seenKeys = new Set<string>();
    for (const token of this.findTokens(input.bodies)) {
      const record = await this.lookup(token);
      if (
        record === null ||
        !isLinkable(record, from, input.receivedAt) ||
        seenKeys.has(record.s3Key)
      ) {
        continue;
      }
      seenKeys.add(record.s3Key);
      descriptors.push({
        id: `link-${descriptors.length}`,
        filename: record.filename,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        s3Key: record.s3Key,
      });
    }
    return descriptors;
  }

  /** The distinct well-formed tokens linked from the bodies, first appearance first. */
  findTokens(bodies: readonly (string | undefined)[]): string[] {
    const tokens = new Set<string>();
    for (const body of bodies) {
      if (body === undefined) {
        continue;
      }
      for (const match of body.matchAll(this.linkPattern)) {
        const token = match[1];
        if (token !== undefined && isValidDownloadToken(token)) {
          tokens.add(token);
        }
        if (tokens.size >= MAX_LINKED_ATTACHMENTS) {
          return [...tokens];
        }
      }
    }
    return [...tokens];
  }

  private async lookup(token: string): Promise<GetDownloadTokenOutput | null> {
    try {
      return await this.tokens.getDownloadToken({ token });
    } catch (error) {
      logger.warn('Inbound: could not look up a download link; leaving it as a link.', error);
      return null;
    }
  }
}

function isLinkable(record: GetDownloadTokenOutput, from: string, receivedAt: string): boolean {
  return (
    !record.revoked &&
    record.expiresAt > receivedAt &&
    record.sender === from &&
    (record.ownDomainRecipients?.length ?? 0) > 0 &&
    record.s3Key.startsWith(SENT_ATTACHMENTS_PREFIX)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
