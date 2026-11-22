/**
 * Forwards a received message to the addresses its forwarding rules name. Driven by the
 * email-received notification (SNS) rather than run inside the parser, so a failed send retries
 * and dead-letters on its own without re-running ingest, and the parser — which reads untrusted
 * MIME — never holds permission to send mail.
 *
 * One notification → at most one SES send, to every matched rule's targets together:
 * 1. List the rules (a small table, read per message so an edit applies to the next one) and
 *    match them against the notification's own From/To/Cc, as if the sender were authenticated
 *    (SES's DMARC result is only in the raw MIME). Most mail matches nothing and stops here,
 *    without reading its row or raw MIME. A notification whose recipient lists were cut to the
 *    cap can't rule a message out, so it goes on to the row's full lists.
 * 2. Read the row: skip anything already forwarded or not clean, and match again on the row.
 * 3. Read the raw MIME (the copy is made from it), take SES's DMARC result from its headers, and
 *    match for real: a rule matches only an authenticated From domain, unless it sets
 *    `ignoreDmarcVerification`.
 * 4. Rewrite the headers (see `utils/forward-mime.ts`), send, and record the forward on the row.
 *
 * Delivery is at-least-once (SNS and SQS redeliver, and the parser republishes on a redelivered
 * event), so the row's `forward` is the duplicate guard. It is written after the send: a crash
 * between the two can forward a message twice, which is better than never forwarding it. Only an
 * infra failure (DynamoDB, S3, SES) throws, so the queue redelivers and eventually dead-letters.
 */
import { EMAIL_RECEIVED_TYPE, type ForwardingRule } from '@freemail/shared';
import { INBOUND_PARTITION, type EmailsDao } from '../data/emails-dao.js';
import type { ForwardingRulesDao } from '../data/forwarding-rules-dao.js';
import type { RawMessageReader } from '../facades/s3-raw-message-reader.js';
import type { SesSender } from '../facades/ses-email-facade.js';
import { decodeEmailRef, type EmailRef } from '../utils/email-ref.js';
import { FORWARDED_MARKER_HEADER, buildForwardedMime } from '../utils/forward-mime.js';
import { domainOf, isSenderAuthenticated, matchForwardingRules } from '../utils/forwarding-match.js';
import { headerValues, parseHeaderLines, rootHeaderBlock } from '../utils/inbound-headers.js';
import { getLogger } from '../utils/logger.js';
import { dmarcPassDomain } from '../utils/sender-auth.js';

/** The forwarding address's local part, on the deployment's email domain. */
export const FORWARDER_LOCAL_PART = 'forwarding';
/** SES's cap on one message's recipients. */
export const MAX_FORWARD_RECIPIENTS = 50;

/** SES errors that a retry can't fix. Throttling, a paused account and AWS faults still retry. */
const PERMANENT_SES_ERRORS: ReadonlySet<string> = new Set(['MessageRejected', 'BadRequestException']);

const logger = getLogger('ForwardingProcessor');

export interface ForwardingProcessorDeps {
  readonly emails: EmailsDao;
  readonly rules: ForwardingRulesDao;
  readonly rawMessages: RawMessageReader;
  readonly ses: SesSender;
  /** This deployment's email domain: the forwarding address's, and never a forward target. */
  readonly emailDomain: string;
  readonly now?: () => Date;
}

export interface ForwardReceivedEmailRequest {
  /** An `EmailReceivedNotification` as JSON (the queue message's body; SNS delivers it raw). */
  readonly message: string;
}

export interface ForwardReceivedEmailResponse {
  readonly outcome: 'forwarded' | 'duplicate' | 'skipped';
  /** The received message's id, once known. */
  readonly messageId?: string;
  /** Why a message was skipped. */
  readonly reason?: string;
  /** The rules that matched, when forwarded. */
  readonly ruleIds?: readonly string[];
  /** How many addresses the copy went to, when forwarded. */
  readonly recipientCount?: number;
}

export class ForwardingProcessor {
  private readonly deps: ForwardingProcessorDeps;
  private readonly now: () => Date;

  constructor(deps: ForwardingProcessorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async forwardReceivedEmail(request: ForwardReceivedEmailRequest): Promise<ForwardReceivedEmailResponse> {
    const notification = parseNotification(request.message);
    if (notification === undefined || notification.ref.pk !== INBOUND_PARTITION) {
      return { outcome: 'skipped', reason: 'not a received-email notification' };
    }
    const rules = (await this.deps.rules.listForwardingRules({})).rules;
    if (notification.candidate !== undefined && !couldMatch(rules, notification.candidate)) {
      return {
        outcome: 'skipped',
        messageId: inboundMessageId(notification.ref),
        reason: 'no matching rule',
      };
    }

    const ref = notification.ref;
    const row = await this.deps.emails.getEmail({ pk: ref.pk, sk: ref.sk });
    if (row === null || row.direction !== 'inbound') {
      return { outcome: 'skipped', reason: 'message not found' };
    }
    const messageId = row.id;
    if (row.forward !== undefined) {
      return { outcome: 'duplicate', messageId };
    }
    // The subscription already filters spam out; this also refuses anything not fully clean.
    if (row.quarantined || row.virusVerdict !== 'PASS' || row.parseStatus !== 'ok') {
      return { outcome: 'skipped', messageId, reason: 'not clean' };
    }
    // The row's recipient lists: the only check when the notification's were cut short.
    const candidate: Candidate = { from: row.from, recipients: [...row.to, ...row.cc] };
    // A reply to the forwarding address (an auto-acknowledgement of a forward, say) is never
    // forwarded on: otherwise a rule on this domain and an outside auto-responder would loop.
    const forwarderAddress = this.forwarderAddress().toLowerCase();
    if (candidate.recipients.some((address) => address.trim().toLowerCase() === forwarderAddress)) {
      return { outcome: 'skipped', messageId, reason: 'addressed to the forwarding address' };
    }
    if (!couldMatch(rules, candidate)) {
      return { outcome: 'skipped', messageId, reason: 'no matching rule' };
    }

    const raw = await this.deps.rawMessages.getRawMessage(row.rawS3Key);
    if (raw === null) {
      return { outcome: 'skipped', messageId, reason: 'raw message expired' };
    }
    const headerBlock = rootHeaderBlock(raw);
    if (headerBlock === undefined) {
      return { outcome: 'skipped', messageId, reason: 'no header block' };
    }
    const lines = parseHeaderLines(headerBlock.toString('latin1'));
    if (headerValues(lines, FORWARDED_MARKER_HEADER).length > 0) {
      return { outcome: 'skipped', messageId, reason: 'already a forwarded copy' };
    }
    // An automatic reply (RFC 3834) is never forwarded, the other half of the loop guard.
    // `auto-generated` mail (notifications, receipts) is forwarded like any other.
    if (headerValues(lines, 'auto-submitted').some((value) => value.split(';')[0]?.trim().toLowerCase() === 'auto-replied')) {
      return { outcome: 'skipped', messageId, reason: 'an automatic reply' };
    }
    const authenticatedDomain = dmarcPassDomain(lines);
    const match = matchForwardingRules(rules, { ...candidate, authenticatedDomain });
    if (match.ruleIds.length === 0) {
      return {
        outcome: 'skipped',
        messageId,
        reason: 'no matching rule (sender not authenticated)',
      };
    }
    const targets = this.targets(match.forwardTo, messageId);
    if (targets.length === 0) {
      return { outcome: 'skipped', messageId, reason: 'no target outside this domain' };
    }

    const forwarded = buildForwardedMime({
      raw,
      forwarderAddress: this.forwarderAddress(),
      forwarderLabel: this.deps.emailDomain,
      from: row.from,
      fromName: row.fromName,
      messageId,
      // Only a rule that skips DMARC matches an unverified sender; the copy then says so.
      senderVerified: isSenderAuthenticated(row.from, authenticatedDomain),
    });
    if (forwarded === undefined) {
      return { outcome: 'skipped', messageId, reason: 'no header block' };
    }
    let sent: { readonly messageId: string };
    try {
      sent = await this.deps.ses.send({
        from: this.forwarderAddress(),
        // The SMTP envelope only: a raw message keeps its own To/Cc headers (the original's), so
        // the targets never appear in it or see each other.
        to: targets,
        cc: [],
        bcc: [],
        raw: forwarded,
      });
    } catch (err) {
      // A rejection retries the same way every time (an unverified target in the SES sandbox, a
      // message SES won't send): skip it rather than retry for half an hour into the DLQ.
      if (err instanceof Error && PERMANENT_SES_ERRORS.has(err.name)) {
        logger.warn(`SES rejected the forward of message ${messageId} (${err.name}): ${err.message}`);
        return { outcome: 'skipped', messageId, reason: `rejected by SES (${err.name})` };
      }
      throw err;
    }
    const recorded = await this.deps.emails.updateInboundEmailForward({
      id: row.id,
      receivedAt: row.receivedAt,
      forward: {
        to: targets,
        ruleIds: match.ruleIds,
        sesMessageId: sent.messageId,
        forwardedAt: this.now().toISOString(),
      },
    });
    if (!recorded.recorded) {
      logger.warn(`Message ${messageId} was forwarded, but a forward was already recorded.`);
    }
    return {
      outcome: 'forwarded',
      messageId,
      ruleIds: match.ruleIds,
      recipientCount: targets.length,
    };
  }

  /** The matched targets minus this deployment's own domain (a loop), capped at SES's limit. */
  private targets(forwardTo: readonly string[], messageId: string): string[] {
    const ownDomain = this.deps.emailDomain.toLowerCase();
    const outside = forwardTo.filter((address) => domainOf(address) !== ownDomain);
    if (outside.length > MAX_FORWARD_RECIPIENTS) {
      logger.warn(`Message ${messageId} matched ${outside.length} forward targets; ` + `only the first ${MAX_FORWARD_RECIPIENTS} are used.`);
    }
    return outside.slice(0, MAX_FORWARD_RECIPIENTS);
  }

  private forwarderAddress(): string {
    return `${FORWARDER_LOCAL_PART}@${this.deps.emailDomain}`;
  }
}

/** A message's From address and its To and Cc addresses. */
interface Candidate {
  readonly from: string;
  readonly recipients: readonly string[];
}

interface ReceivedNotification {
  /** The stored row the notification names. */
  readonly ref: EmailRef;
  /** The notification's From/To/Cc; absent when a recipient list was cut to the cap or malformed. */
  readonly candidate?: Candidate;
}

/**
 * Whether any rule could match, assuming the sender is authenticated. False → no rule matches
 * however the DMARC check went.
 */
function couldMatch(rules: readonly ForwardingRule[], candidate: Candidate): boolean {
  const match = matchForwardingRules(rules, {
    ...candidate,
    authenticatedDomain: domainOf(candidate.from),
  });
  return match.ruleIds.length > 0;
}

/** The email-received notification in a message, or undefined for anything else. */
function parseNotification(message: string): ReceivedNotification | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const notification = parsed as Record<string, unknown>;
  if (notification.type !== EMAIL_RECEIVED_TYPE || typeof notification.id !== 'string') {
    return undefined;
  }
  let ref: EmailRef;
  try {
    ref = decodeEmailRef(notification.id);
  } catch {
    return undefined;
  }
  const from = notification.from;
  const to = stringList(notification.to);
  const cc = stringList(notification.cc);
  if (notification.recipientsTruncated === true || typeof from !== 'string' || to === undefined || cc === undefined) {
    return { ref };
  }
  return { ref, candidate: { from, recipients: [...to, ...cc] } };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return undefined;
  }
  return value as string[];
}

/** The received message's id: an inbound row's sort key is `<receivedAt>#<id>`. */
function inboundMessageId(ref: EmailRef): string {
  return ref.sk.slice(ref.sk.indexOf('#') + 1);
}
