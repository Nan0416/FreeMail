import { useState } from 'react';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type EmailAttachment,
  type SendEmailRequest,
} from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';

/** Split a comma/newline-separated recipient string into trimmed, non-empty addresses. */
function parseRecipients(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Read a File into a base64 string (no `data:` prefix), as the API's `contentBase64` expects. */
function fileToAttachment(file: File): Promise<EmailAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

type SentState = { id: string; messageId: string } | null;

export function ComposeView(): React.JSX.Element {
  const { client } = useAuth();
  const [from, setFrom] = useState('');
  const [fromName, setFromName] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [format, setFormat] = useState<'text' | 'html'>('text');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentState>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSent(null);

    const recipients = {
      to: parseRecipients(to),
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
    };
    if (recipients.to.length + recipients.cc.length + recipients.bcc.length === 0) {
      setError('Add at least one recipient (To, Cc, or Bcc).');
      return;
    }
    if (body.trim().length === 0) {
      setError('The message body is empty.');
      return;
    }
    if (files.length > MAX_ATTACHMENTS) {
      setError(`At most ${MAX_ATTACHMENTS} attachments are allowed.`);
      return;
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      setError(
        `Attachments total ${(totalBytes / (1024 * 1024)).toFixed(1)} MB — the limit is ` +
          `${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB.`,
      );
      return;
    }

    setBusy(true);
    try {
      const attachments = await Promise.all(files.map(fileToAttachment));
      const request: SendEmailRequest = { from };
      if (fromName.trim()) request.fromName = fromName.trim();
      if (recipients.to.length) request.to = recipients.to;
      if (recipients.cc.length) request.cc = recipients.cc;
      if (recipients.bcc.length) request.bcc = recipients.bcc;
      if (subject.trim()) request.subject = subject;
      // Send as the selected body part; the API requires at least one of text/html.
      if (format === 'html') {
        request.html = body;
      } else {
        request.text = body;
      }
      if (attachments.length) request.attachments = attachments;

      const result = await client.sendEmail(request);
      setSent({ id: result.id, messageId: result.messageId });
      setTo('');
      setCc('');
      setBcc('');
      setSubject('');
      setBody('');
      setFiles([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to send the email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Compose</h2>
      <form onSubmit={onSubmit} aria-label="Compose email">
        <label htmlFor="from">From</label>
        <input
          id="from"
          type="text"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="you@your-domain.com"
          required
        />
        <p className="hint">Must be an address under your configured email domain.</p>

        <label htmlFor="fromName">From name (optional)</label>
        <input
          id="fromName"
          type="text"
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
        />

        <label htmlFor="to">To</label>
        <input
          id="to"
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Comma-separated addresses"
        />

        <label htmlFor="cc">Cc</label>
        <input id="cc" type="text" value={cc} onChange={(e) => setCc(e.target.value)} />

        <label htmlFor="bcc">Bcc</label>
        <input id="bcc" type="text" value={bcc} onChange={(e) => setBcc(e.target.value)} />

        <label htmlFor="subject">Subject</label>
        <input
          id="subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />

        <label htmlFor="format">Body format</label>
        <select
          id="format"
          value={format}
          onChange={(e) => setFormat(e.target.value === 'html' ? 'html' : 'text')}
        >
          <option value="text">Plain text</option>
          <option value="html">HTML</option>
        </select>

        <label htmlFor="body">Message</label>
        <textarea
          id="body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={format === 'html' ? '<p>Your HTML…</p>' : undefined}
          required
        />

        <label htmlFor="attachments">Attachments</label>
        <input
          id="attachments"
          type="file"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        {files.length > 0 && (
          <p className="hint">
            {files.length} file{files.length === 1 ? '' : 's'} attached.
          </p>
        )}

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {sent && (
          <p role="status" className="success">
            Sent. Message id: <code>{sent.messageId}</code>
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
