import type { EmailDetail } from '@freemail/shared';
import { formatLongDate } from './format.js';

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

export interface ComposePrefill {
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The quoted body as PLAIN TEXT. Inbound HTML is untrusted: it is never fed to the editor,
 * which would fetch its remote images (tracking pixels) and carry its markup into a
 * message we send. Text is taken from the text part, or else extracted from the HTML with
 * an inert `DOMParser` document (no scripts run, no resources load).
 */
export function quotedText(email: EmailDetail): string {
  if (email.text !== undefined) {
    return email.text;
  }
  if (email.html !== undefined) {
    const doc = new DOMParser().parseFromString(email.html, 'text/html');
    return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

function quoteBlock(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<blockquote>${paragraphs || '<p></p>'}</blockquote>`;
}

function withPrefix(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = prefix === 'Re' ? /^re:/i : /^(fwd?|fw):/i;
  return re.test(subject.trim()) ? subject : `${prefix}: ${subject}`;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function domainOf(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Which of our addresses an inbound message reached, so the reply goes out from it.
 * Preference: a recipient on the same domain as the last address we sent from, then the
 * last sender itself, then the first recipient.
 */
export function replySender(email: EmailDetail, lastSender: string): string {
  if (email.direction === 'sent') {
    return email.from;
  }
  const recipients = [...email.to, ...email.cc];
  const ourDomain = domainOf(lastSender);
  const onOurDomain = ourDomain ? recipients.find((r) => domainOf(r) === ourDomain) : undefined;
  return onOurDomain ?? (lastSender || recipients[0] || '');
}

/**
 * Prefill a compose window for reply / reply-all / forward. The API sends each message
 * standalone (it cannot set `In-Reply-To`), so this is a new message with a quoted body.
 */
export function buildPrefill(
  email: EmailDetail,
  mode: ReplyMode,
  lastSender: string,
): ComposePrefill {
  const from = replySender(email, lastSender);
  const sender = email.fromName
    ? `${escapeHtml(email.fromName)} &lt;${escapeHtml(email.from)}&gt;`
    : escapeHtml(email.from);
  const when = escapeHtml(formatLongDate(email.headerDate ?? email.date));
  const quoted = quoteBlock(quotedText(email));

  if (mode === 'forward') {
    const header =
      `<p>---------- Forwarded message ----------<br>` +
      `From: ${sender}<br>Date: ${when}<br>` +
      `Subject: ${escapeHtml(email.subject)}<br>` +
      `To: ${escapeHtml(email.to.join(', '))}</p>`;
    return {
      from,
      to: '',
      cc: '',
      subject: withPrefix(email.subject, 'Fwd'),
      html: `<p></p>${header}${quoted}`,
    };
  }

  // Replying to our own sent message continues to its recipients rather than ourselves.
  const primary = email.direction === 'sent' ? [...email.to] : [email.from];
  const others =
    mode === 'replyAll'
      ? [...(email.direction === 'sent' ? [] : email.to), ...email.cc].filter(
          (a) => !sameAddress(a, from) && !primary.some((p) => sameAddress(p, a)),
        )
      : [];
  return {
    from,
    to: primary.join(', '),
    cc: others.join(', '),
    subject: withPrefix(email.subject, 'Re'),
    html: `<p></p><p>On ${when}, ${sender} wrote:</p>${quoted}`,
  };
}
