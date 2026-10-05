import type { EmailDetail } from '@freemail/shared';

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
}

/**
 * The hide-by-default notice for a quarantined inbound message, or null when the message
 * is not quarantined (render its body directly). Mirrors the server's exposure model:
 * a virus-fail / parse-fail message has NO body (nothing to reveal); a spam-flagged but
 * otherwise-exposable message keeps its body behind an explicit reveal.
 */
export function quarantineNotice(email: EmailDetail): QuarantineNotice | null {
  if (email.direction !== 'inbound' || !email.quarantined) {
    return null;
  }
  if (email.virusVerdict && email.virusVerdict !== 'PASS') {
    return {
      message: `Withheld — this message failed a virus scan (virus verdict: ${email.virusVerdict}). Its content is hidden.`,
      canReveal: false,
    };
  }
  if (email.parseStatus && email.parseStatus !== 'ok') {
    return {
      message: `This message could not be fully parsed (${email.parseStatus}). Its content is hidden.`,
      canReveal: false,
    };
  }
  const hasBody = bodyKind(email) !== 'none';
  return { message: 'This message was flagged as spam.', canReveal: hasBody };
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
