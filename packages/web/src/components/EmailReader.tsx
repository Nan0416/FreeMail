import { useEffect, useState } from 'react';
import type { EmailAttachmentInfo, EmailDetail } from '@freemail/shared';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/auth-context.js';
import { bodyKind, formatSender, quarantineNotice } from '../lib/email-reader.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { EmailBodyFrame } from './EmailBodyFrame.js';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; email: EmailDetail };

export interface EmailReaderProps {
  /** Opaque message handle from the list. */
  id: string;
  /** Return to the list. */
  onBack: () => void;
}

export function EmailReader({ id, onBack }: EmailReaderProps): React.JSX.Element {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ status: 'loading' });
  // Remote images blocked by default (tracking pixels); revealed per message.
  const [showImages, setShowImages] = useState(false);
  // Quarantined (spam) bodies stay hidden until the reader opts in.
  const [revealed, setRevealed] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    setShowImages(false);
    setRevealed(false);
    setDownloadError(null);
    client
      .getEmail(id)
      .then((email) => {
        if (active) {
          setState({ status: 'ready', email });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: err instanceof ApiError ? err.message : 'Could not load this message.',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [client, id]);

  async function download(attachment: EmailAttachmentInfo): Promise<void> {
    setDownloadError(null);
    try {
      const { url } = await client.getAttachmentUrl(id, attachment.id);
      // The presigned URL forces `Content-Disposition: attachment` + octet-stream, so a
      // plain anchor click downloads it (never renders inline) and the SPA stays put.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.rel = 'noopener noreferrer';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      setDownloadError(
        err instanceof ApiError ? err.message : 'Could not download the attachment.',
      );
    }
  }

  if (state.status === 'loading') {
    return (
      <section className="card">
        <button type="button" className="link-back" onClick={onBack}>
          ← Back
        </button>
        <p className="muted">Loading…</p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="card">
        <button type="button" className="link-back" onClick={onBack}>
          ← Back
        </button>
        <p role="alert" className="error">
          {state.message}
        </p>
      </section>
    );
  }

  const { email } = state;
  const notice = quarantineNotice(email);
  const showBody = !notice || revealed;

  return (
    <section className="card email-reader">
      <button type="button" className="link-back" onClick={onBack}>
        ← Back
      </button>

      <h2>{email.subject || '(no subject)'}</h2>
      <dl className="email-headers">
        <dt>From</dt>
        <dd>{formatSender(email)}</dd>
        <dt>To</dt>
        <dd>{email.to.length ? email.to.join(', ') : '—'}</dd>
        {email.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{email.cc.join(', ')}</dd>
          </>
        )}
        {email.bcc && email.bcc.length > 0 && (
          <>
            <dt>Bcc</dt>
            <dd>{email.bcc.join(', ')}</dd>
          </>
        )}
        <dt>Date</dt>
        <dd>{formatDate(email.date)}</dd>
      </dl>

      {email.direction === 'sent' ? (
        <p className="muted">This message&rsquo;s body isn&rsquo;t stored (sent metadata only).</p>
      ) : (
        <div className="email-body">
          {notice && (
            <div role="alert" className="quarantine-banner">
              <p>{notice.message}</p>
              {notice.canReveal && !revealed && (
                <button type="button" onClick={() => setRevealed(true)}>
                  Show message
                </button>
              )}
            </div>
          )}

          {showBody && (
            <BodyContent
              email={email}
              showImages={showImages}
              onToggleImages={() => setShowImages((v) => !v)}
            />
          )}
        </div>
      )}

      {email.attachments.length > 0 && (
        <div className="email-attachments">
          <h3>Attachments</h3>
          <ul className="attachment-list" aria-label="Attachments">
            {email.attachments.map((attachment) => (
              <li key={attachment.id}>
                <div>
                  <span className="attachment-name">{attachment.filename}</span>
                  <span className="hint">
                    {attachment.contentType} · {formatBytes(attachment.sizeBytes)}
                  </span>
                </div>
                <button type="button" onClick={() => void download(attachment)}>
                  Download
                </button>
              </li>
            ))}
          </ul>
          {downloadError && (
            <p role="alert" className="error">
              {downloadError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BodyContent({
  email,
  showImages,
  onToggleImages,
}: {
  email: EmailDetail;
  showImages: boolean;
  onToggleImages: () => void;
}): React.JSX.Element {
  const kind = bodyKind(email);
  return (
    <>
      {kind === 'html' && (
        <div className="image-toggle">
          <button type="button" onClick={onToggleImages}>
            {showImages ? 'Hide images' : 'Show images'}
          </button>
          {!showImages && <span className="hint">Remote images are blocked.</span>}
        </div>
      )}
      {kind === 'html' && email.html !== undefined && (
        <EmailBodyFrame html={email.html} allowImages={showImages} />
      )}
      {kind === 'text' && <pre className="email-text">{email.text}</pre>}
      {kind === 'none' && <p className="muted">This message has no readable body.</p>}
      {email.bodyTruncated && <p className="hint">This message was truncated for display.</p>}
    </>
  );
}
