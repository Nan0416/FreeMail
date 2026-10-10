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
 * A link counts only when the message is authenticated as coming from its From domain (SES's
 * own DMARC check passed) and the link's token vouches for it: it exists and is live, its
 * message was sent to at least one of this deployment's own addresses, and by the same address
 * this message is from. A link in anyone else's mail — or in mail merely claiming your From —
 * stays just a link.
 *
 * Best-effort throughout: a failed lookup leaves the link as a link, at most
 * {@link MAX_LINKED_ATTACHMENTS} links are looked up, and only the part of each body the parser
 * keeps (its first 1 MiB of characters) is searched — a link past that stays a link.
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

export interface ResolveLinkedAttachmentsServiceRequest {
  /** The message's decoded text and HTML bodies (either may be absent). */
  readonly bodies: readonly (string | undefined)[];
  /** The message's From address. */
  readonly from: string;
  /** The From domain SES's DMARC check passed for; absent → no link is honored. */
  readonly authenticatedDomain: string | undefined;
  /** When it was received (ISO-8601 UTC); a token must still be live then. */
  readonly receivedAt: string;
}

export interface ResolveLinkedAttachmentsServiceResponse {
  /** The linked files to carry as attachments, in the order their links appear. */
  readonly attachments: readonly InboundAttachmentDescriptor[];
}

export class OwnLinkAttachments {
  private readonly linkPattern: RegExp;

  /** `downloadBaseUrl` is the API's public base, exactly as the send path builds links. */
  constructor(
    private readonly tokens: DownloadTokensDao,
    downloadBaseUrl: string,
  ) {
    const base = escapeRegExp(downloadBaseUrl.replace(/\/+$/, ''));
    // Case-insensitive, so a host or scheme in another case still matches (and so does the
    // `/d/`); the token is then checked to be exactly a minted one.
    this.linkPattern = new RegExp(`${base}/d/([A-Za-z0-9_-]+)`, 'gi');
  }

  async resolve(
    request: ResolveLinkedAttachmentsServiceRequest,
  ): Promise<ResolveLinkedAttachmentsServiceResponse> {
    const from = request.from.trim().toLowerCase();
    if (
      request.authenticatedDomain === undefined ||
      domainOf(from) !== request.authenticatedDomain.toLowerCase()
    ) {
      return { attachments: [] };
    }
    const attachments: InboundAttachmentDescriptor[] = [];
    const seenKeys = new Set<string>();
    for (const token of findTokens(this.linkPattern, request.bodies)) {
      const record = await this.lookup(token);
      if (
        record === null ||
        !isLinkable(record, from, request.receivedAt) ||
        seenKeys.has(record.s3Key)
      ) {
        continue;
      }
      seenKeys.add(record.s3Key);
      attachments.push({
        id: `link-${attachments.length}`,
        filename: record.filename,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        s3Key: record.s3Key,
      });
    }
    return { attachments };
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

/** The distinct well-formed tokens linked from the bodies, first appearance first. */
function findTokens(pattern: RegExp, bodies: readonly (string | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const body of bodies) {
    if (body === undefined) {
      continue;
    }
    for (const match of body.matchAll(pattern)) {
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

function isLinkable(record: GetDownloadTokenOutput, from: string, receivedAt: string): boolean {
  return (
    !record.revoked &&
    record.expiresAt > receivedAt &&
    record.sender === from &&
    (record.ownDomainRecipients?.length ?? 0) > 0 &&
    record.s3Key.startsWith(SENT_ATTACHMENTS_PREFIX)
  );
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
