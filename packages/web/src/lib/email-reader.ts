import type { EmailDetail, InboundParseStatus, InboundVerdict } from '@freemail/shared';

/** Which body part the reader should render for an exposable message. */
export type BodyKind = 'html' | 'text' | 'none';

export function bodyKind(email: EmailDetail): BodyKind {
  if (email.html !== undefined) {
    return 'html';
  }
  if (email.text !== undefined) {
    return 'text';
  }
  return 'none';
}

export interface QuarantineNotice {
  readonly message: string;
  /** True only when a body actually exists to reveal (spam-flagged, virus-PASS, parse-ok). */
  readonly canReveal: boolean;
  /** True when the message's original (.eml) can be downloaded from the notice. */
  readonly offerDownload: boolean;
  /** True when that original lacks a virus PASS — the download must carry a warning. */
  readonly suspicious: boolean;
}

/** Why a received message's content could not be extracted, for its tag and notice. */
export interface FailureReason {
  /** A short tag for the message list, e.g. `Virus`. */
  readonly label: string;
  /** Completes "This message could not be processed: …". */
  readonly detail: string;
  /** True when SES did not confirm the message virus-free. */
  readonly suspicious: boolean;
}

/**
 * The reason a received message's content was withheld, or null when it wasn't (it is clean
 * and parsed — at most spam). A virus verdict other than PASS outranks a parse problem.
 */
export function failureReason(email: {
  readonly virusVerdict?: InboundVerdict;
  readonly parseStatus?: InboundParseStatus;
}): FailureReason | null {
  if (email.virusVerdict !== undefined && email.virusVerdict !== 'PASS') {
    if (email.virusVerdict === 'FAIL') {
      return { label: 'Virus', detail: 'it failed a virus scan', suspicious: true };
    }
    if (email.virusVerdict === 'GRAY') {
      return { label: 'Suspicious', detail: 'the virus scan could not clear it', suspicious: true };
    }
    return { label: 'Not scanned', detail: 'it was not virus-scanned', suspicious: true };
  }
  switch (email.parseStatus) {
    case 'oversize':
      return { label: 'Too large', detail: 'it is larger than 40 MB', suspicious: false };
    case 'limit_exceeded':
      return {
        label: 'Over limits',
        detail: 'it has too many, or too large, attachments',
        suspicious: false,
      };
    case 'parse_failed':
      return { label: 'Unreadable', detail: 'its contents could not be parsed', suspicious: false };
    default:
      return null;
  }
}

/**
 * The hide-by-default notice for a quarantined inbound message, or null when the message
 * is not quarantined (render its body directly). Mirrors the server's exposure model:
 * a virus-fail / parse-fail message has NO body (nothing to reveal) — but its original can be
 * downloaded when the server offers it, with a warning when it lacks a virus PASS; a
 * spam-flagged but otherwise-exposable message keeps its body behind an explicit reveal.
 */
export function quarantineNotice(email: EmailDetail): QuarantineNotice | null {
  if (email.direction !== 'inbound' || !email.quarantined) {
    return null;
  }
  const reason = failureReason(email);
  if (reason) {
    const offerDownload = email.rawAvailable === true;
    const suspicious = offerDownload && email.rawSuspicious === true;
    const download = !offerDownload
      ? ''
      : suspicious
        ? ' You can still download the original, but SES did not confirm it is virus-free — only open it if you trust the sender.'
        : ' You can download the original (.eml).';
    return {
      message: `This message could not be processed: ${reason.detail}. Its content is hidden.${download}`,
      canReveal: false,
      offerDownload,
      suspicious,
    };
  }
  const hasBody = bodyKind(email) !== 'none';
  return {
    message: 'This message was flagged as spam.',
    canReveal: hasBody,
    offerDownload: false,
    suspicious: false,
  };
}

/**
 * A delivery-status notice for a sent message, or null when it went out (or is inbound / a
 * legacy row with no status). The body still renders below it — the archive is written
 * before the SES call, so even a failed send has its composed message on file.
 */
export function sentStatusNotice(email: EmailDetail): string | null {
  if (email.direction !== 'sent') {
    return null;
  }
  if (email.status === 'send_failed') {
    return 'This message failed to send and was not delivered.';
  }
  if (email.status === 'sending') {
    return 'This message is still sending (or its delivery status was not recorded).';
  }
  return null;
}

/** Display form of a sender: `Name <addr>` when a display name exists, else the address. */
export function formatSender(email: Pick<EmailDetail, 'from' | 'fromName'>): string {
  return email.fromName ? `${email.fromName} <${email.from}>` : email.from;
}
