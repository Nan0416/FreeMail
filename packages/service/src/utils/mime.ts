/**
 * Builds the raw MIME message handed to SES (raw content). Isolated behind a
 * plain function so it's swappable and unit-testable, and so the service depends
 * on an interface rather than a specific MIME library.
 *
 * BCC never appears in the message headers: nodemailer's `keepBcc` is forced
 * `false` (its default, set explicitly here as a guard), so a `bcc` passed to the
 * composer is stripped from the built message. Blind recipients are delivered via
 * the SES envelope (the `Destination` passed to the sender), never a `Bcc:` header.
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface RawMimeAttachment {
  readonly filename: string;
  readonly contentType: string;
  /** Base64-encoded, whitespace already stripped. */
  readonly contentBase64: string;
}

export interface RawMimeInput {
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /** Passed to the composer but never emitted as a header (see file header). */
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments: readonly RawMimeAttachment[];
}

/** Assemble the message into a raw MIME buffer. */
export function buildRawMime(input: RawMimeInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: input.fromName ? { name: input.fromName, address: input.from } : input.from,
    ...(input.to.length > 0 ? { to: [...input.to] } : {}),
    ...(input.cc.length > 0 ? { cc: [...input.cc] } : {}),
    ...(input.bcc.length > 0 ? { bcc: [...input.bcc] } : {}),
    subject: input.subject,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.html !== undefined ? { html: input.html } : {}),
    attachments: input.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.contentBase64,
      encoding: 'base64',
    })),
  });

  const message = composer.compile();
  // Explicit no-BCC-leak guard: strip any Bcc header from the built message.
  message.keepBcc = false;
  return message.build();
}
