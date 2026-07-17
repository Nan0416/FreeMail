/**
 * Builds the raw MIME message handed to SES `SendRawEmail`. Isolated behind a
 * plain function so it's swappable and unit-testable, and so the service depends
 * on an interface rather than a specific MIME library.
 *
 * BCC is deliberately NOT a header here: a `Bcc:` header in the raw message is
 * visible to recipients (a leak). Blind recipients are delivered via the SES
 * envelope (the `Destination` passed to the sender), so this builder only emits
 * `To`/`Cc` headers.
 */
import { createMimeMessage } from 'mimetext';

export interface RawMimeAttachment {
  filename: string;
  contentType: string;
  /** Base64-encoded, whitespace already stripped. */
  contentBase64: string;
}

export interface RawMimeInput {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments: RawMimeAttachment[];
}

/** Assemble the message into a raw MIME buffer (UTF-8). */
export function buildRawMime(input: RawMimeInput): Buffer {
  const msg = createMimeMessage();

  msg.setSender(input.fromName ? { addr: input.from, name: input.fromName } : input.from);
  if (input.to.length > 0) {
    msg.setTo(input.to);
  }
  if (input.cc.length > 0) {
    msg.setCc(input.cc);
  }
  msg.setSubject(input.subject);

  // A message with both parts becomes multipart/alternative automatically.
  if (input.text !== undefined) {
    msg.addMessage({ contentType: 'text/plain', data: input.text });
  }
  if (input.html !== undefined) {
    msg.addMessage({ contentType: 'text/html', data: input.html });
  }

  for (const attachment of input.attachments) {
    msg.addAttachment({
      filename: attachment.filename,
      contentType: attachment.contentType,
      data: attachment.contentBase64,
    });
  }

  return Buffer.from(msg.asRaw(), 'utf8');
}
