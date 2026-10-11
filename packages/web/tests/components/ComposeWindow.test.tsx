import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadTransport } from '../../src/api/client.js';
import { ComposeWindow, type ComposeInit } from '../../src/components/ComposeWindow.js';
import { resetDraftsCache } from '../../src/lib/drafts.js';
import { callsTo, json, pathOf, renderWithApp } from '../helpers.js';

function api() {
  return vi.fn<typeof fetch>(async (url) => {
    if (pathOf(url) === '/me') {
      return json(200, { subject: 'owner' });
    }
    return json(200, { id: 'm1', messageId: 'ses-123', sentAt: '2026-07-17T00:00:00.000Z' });
  });
}

function renderCompose(init: ComposeInit, fetchImpl = api(), onClose = vi.fn()) {
  renderWithApp(<ComposeWindow init={init} onClose={onClose} />, fetchImpl);
  return { fetchImpl, onClose };
}

function storedDrafts(): { id: string; subject: string }[] {
  return JSON.parse(window.localStorage.getItem('freemail.drafts.v1') ?? '[]');
}

beforeEach(() => {
  window.localStorage.clear();
  resetDraftsCache();
});

describe('ComposeWindow — sending', () => {
  it('requires at least one recipient before sending', async () => {
    const compose = renderCompose({ from: 'me@x.com', html: '<p>hello</p>' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one recipient');
    expect(callsTo(compose.fetchImpl, '/emails')).toHaveLength(0);
  });

  it('refuses an empty message', async () => {
    const compose = renderCompose({ from: 'me@x.com', to: 'a@y.com' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('empty');
    expect(callsTo(compose.fetchImpl, '/emails')).toHaveLength(0);
  });

  it('sends HTML with a plain-text alternative, then clears the draft and closes', async () => {
    const compose = renderCompose({
      draftId: 'd1',
      from: 'me@x.com',
      fromName: 'Me',
      to: 'a@y.com, b@y.com',
      subject: 'Hi',
      html: '<p>hello <strong>there</strong></p>',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    const [[url, init]] = callsTo(compose.fetchImpl, '/emails', 'POST');
    expect(url).toBe('http://api.test/emails');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'me@x.com',
      fromName: 'Me',
      to: ['a@y.com', 'b@y.com'],
      subject: 'Hi',
      html: '<p>hello <strong>there</strong></p>',
      text: 'hello there',
    });
    expect(storedDrafts()).toEqual([]);
    // The sender is remembered for the next compose.
    expect(JSON.parse(window.localStorage.getItem('freemail.sender.v1') ?? '{}')).toEqual({
      address: 'me@x.com',
      name: 'Me',
    });
  });

  it('threads a reply, and keeps a subject the user cleared', async () => {
    const compose = renderCompose({
      from: 'me@x.com',
      to: 'a@y.com',
      subject: 'Re: Hi',
      html: '<p>sure</p>',
      inReplyTo: 'HANDLE-1',
    });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    const [[, init]] = callsTo(compose.fetchImpl, '/emails', 'POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ inReplyTo: 'HANDLE-1', subject: '' });
  });

  it('keeps inReplyTo on the saved draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderCompose({ from: 'me@x.com', subject: 'Re: Hi', inReplyTo: 'HANDLE-2' });
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Re: Hi!' } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(storedDrafts()).toEqual([expect.objectContaining({ inReplyTo: 'HANDLE-2' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the original's attachments by reference, minus any removed", async () => {
    const compose = renderCompose({
      from: 'me@x.com',
      to: 'a@y.com',
      subject: 'Fwd: Docs',
      html: '<p>see below</p>',
      forwardAttachments: [
        { emailId: 'H', attachmentId: '2', filename: 'keep.pdf', sizeBytes: 900 },
        { emailId: 'H', attachmentId: '3', filename: 'drop.zip', sizeBytes: 9_000_000 },
      ],
    });
    expect(screen.getByText('keep.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove forwarded drop.zip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    const [[, init]] = callsTo(compose.fetchImpl, '/emails', 'POST');
    expect(JSON.parse(String(init?.body)).attachments).toEqual([
      { emailId: 'H', attachmentId: '2' },
    ]);
    // Nothing was uploaded for a forwarded file.
    expect(callsTo(compose.fetchImpl, '/attachments/uploads')).toHaveLength(0);
  });

  it('counts forwarded files against the attachment cap', async () => {
    const compose = renderCompose({
      from: 'me@x.com',
      to: 'a@y.com',
      subject: 'Fwd: lots',
      html: '<p>all of them</p>',
      forwardAttachments: Array.from({ length: 21 }, (_v, i) => ({
        emailId: 'H',
        attachmentId: String(i),
        filename: `f${i}.txt`,
        sizeBytes: 10,
      })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('At most 20 attachments');
    expect(callsTo(compose.fetchImpl, '/emails')).toHaveLength(0);
  });

  it('surfaces a send failure and keeps the window open', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      pathOf(url) === '/me'
        ? json(200, { subject: 'owner' })
        : json(400, { error: 'invalid_sender', message: 'From must be under your domain.' }),
    );
    const compose = renderCompose(
      { from: 'me@elsewhere.com', to: 'a@y.com', html: '<p>x</p>' },
      fetchImpl,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('From must be under your domain.');
    expect(compose.onClose).not.toHaveBeenCalled();
  });
});

describe('ComposeWindow — attachments', () => {
  const S3_URL = 'https://mail-bucket.s3.us-east-1.amazonaws.com/uploads/U1?X-Amz-Signature=s';

  function uploadingApi() {
    return vi.fn<typeof fetch>(async (url) => {
      if (String(url).startsWith('https://mail-bucket.s3.')) {
        return new Response(null, { status: 200 });
      }
      if (pathOf(url) === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (pathOf(url) === '/attachments/uploads') {
        return json(201, {
          uploadId: 'U1',
          uploadUrl: S3_URL,
          uploadMethod: 'PUT',
          expiresAt: '2026-10-10T00:15:00.000Z',
        });
      }
      return json(200, { id: 'm1', messageId: 'ses-123', sentAt: '2026-07-17T00:00:00.000Z' });
    });
  }

  function attach(file: File) {
    fireEvent.change(screen.getByLabelText('Attach files', { selector: 'input' }), {
      target: { files: [file] },
    });
  }

  it('uploads each file straight to S3, then sends only its upload id', async () => {
    const compose = renderCompose(
      { from: 'me@x.com', to: 'a@y.com', html: '<p>see attached</p>' },
      uploadingApi(),
    );
    const file = new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' });
    attach(file);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    const [[, createInit]] = callsTo(compose.fetchImpl, '/attachments/uploads', 'POST');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: file.size,
    });
    const puts = compose.fetchImpl.mock.calls.filter(([url]) => url === S3_URL);
    expect(puts).toHaveLength(1);
    expect(puts[0][1]?.method).toBe('PUT');
    expect(puts[0][1]?.body).toBe(file);
    const [[, sendInit]] = callsTo(compose.fetchImpl, '/emails', 'POST');
    expect(JSON.parse(String(sendInit?.body)).attachments).toEqual([{ uploadId: 'U1' }]);
  });

  it('refuses a file over 100 MB before uploading anything', async () => {
    const compose = renderCompose(
      { from: 'me@x.com', to: 'a@y.com', html: '<p>x</p>' },
      uploadingApi(),
    );
    const huge = new File(['x'], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: 100 * 1024 * 1024 + 1 });
    attach(huge);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('limit is 100 MB per attachment');
    expect(callsTo(compose.fetchImpl, '/attachments/uploads')).toHaveLength(0);
    expect(callsTo(compose.fetchImpl, '/emails')).toHaveLength(0);
  });

  it('reuses a finished upload when Send is pressed again after a rejected send', async () => {
    const fetchImpl = uploadingApi();
    const base = fetchImpl.getMockImplementation();
    let sends = 0;
    fetchImpl.mockImplementation(async (url, init) => {
      if (pathOf(url) === '/emails' && init?.method === 'POST') {
        sends += 1;
        if (sends === 1) {
          return json(400, { error: 'invalid_request', message: 'Bad recipient.' });
        }
      }
      return base!(url, init);
    });
    const compose = renderCompose({ from: 'me@x.com', to: 'a@y.com', html: '<p>x</p>' }, fetchImpl);
    attach(new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }));

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad recipient.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    expect(callsTo(fetchImpl, '/attachments/uploads')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([url]) => url === S3_URL)).toHaveLength(1);
    const sendBodies = callsTo(fetchImpl, '/emails', 'POST').map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(sendBodies.map((body) => body.attachments)).toEqual([
      [{ uploadId: 'U1' }],
      [{ uploadId: 'U1' }],
    ]);
  });

  it('refuses an empty file before uploading anything', async () => {
    const compose = renderCompose(
      { from: 'me@x.com', to: 'a@y.com', html: '<p>x</p>' },
      uploadingApi(),
    );
    attach(new File([], 'empty.txt', { type: 'text/plain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('"empty.txt" is empty');
    expect(callsTo(compose.fetchImpl, '/attachments/uploads')).toHaveLength(0);
  });

  /** The API, minting one upload per file — its id is the filename. */
  function perFileUploadsApi() {
    return vi.fn<typeof fetch>(async (url, init) => {
      if (pathOf(url) === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (pathOf(url) === '/attachments/uploads') {
        const filename = JSON.parse(String(init?.body)).filename as string;
        return json(201, {
          uploadId: filename,
          uploadUrl: `https://mail-bucket.s3.us-east-1.amazonaws.com/uploads/${filename}`,
          uploadMethod: 'PUT',
          expiresAt: '2026-10-10T00:15:00.000Z',
        });
      }
      return json(200, { id: 'm1', messageId: 'ses-123', sentAt: '2026-07-17T00:00:00.000Z' });
    });
  }

  /** An S3 stand-in whose PUTs stay open until the test finishes them. */
  function heldUploads() {
    const open = new Map<string, { report: (bytes: number) => void; finish: () => void }>();
    const uploadImpl: UploadTransport = (url, _file, _type, onProgress) =>
      new Promise((resolve) => {
        open.set(new URL(url).pathname.split('/').pop() ?? '', {
          report: onProgress,
          finish: () => resolve(200),
        });
      });
    return { open, uploadImpl };
  }

  function renderWithUploads(fetchImpl: typeof fetch, uploadImpl: UploadTransport) {
    const onClose = vi.fn();
    renderWithApp(
      <ComposeWindow
        init={{ from: 'me@x.com', to: 'a@y.com', html: '<p>files</p>' }}
        onClose={onClose}
      />,
      fetchImpl,
      uploadImpl,
    );
    return onClose;
  }

  it('uploads up to four files at once and sends them in the order they were attached', async () => {
    const fetchImpl = perFileUploadsApi();
    const s3 = heldUploads();
    const onClose = renderWithUploads(fetchImpl, s3.uploadImpl);
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
    fireEvent.change(screen.getByLabelText('Attach files', { selector: 'input' }), {
      target: { files: names.map((name) => new File(['data'], name, { type: 'text/plain' })) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect([...s3.open.keys()]).toEqual(names.slice(0, 4)));
    // Finishing one frees a slot for the fifth; the rest finish out of order.
    await act(async () => s3.open.get('c.txt')?.finish());
    await waitFor(() => expect(s3.open.has('e.txt')).toBe(true));
    for (const name of ['e.txt', 'd.txt', 'b.txt', 'a.txt']) {
      await act(async () => s3.open.get(name)?.finish());
    }

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [[, sendInit]] = callsTo(fetchImpl, '/emails', 'POST');
    expect(JSON.parse(String(sendInit?.body)).attachments).toEqual(
      names.map((name) => ({ uploadId: name })),
    );
  });

  it("shows each file's upload progress and the overall percent on the send button", async () => {
    const s3 = heldUploads();
    renderWithUploads(perFileUploadsApi(), s3.uploadImpl);
    fireEvent.change(screen.getByLabelText('Attach files', { selector: 'input' }), {
      target: {
        files: [
          new File(['12345678'], 'big.bin', { type: 'application/octet-stream' }),
          new File(['12'], 'small.txt', { type: 'text/plain' }),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(s3.open.size).toBe(2));

    await act(async () => {
      s3.open.get('big.bin')?.report(4);
      s3.open.get('small.txt')?.report(2);
    });
    expect(screen.getByRole('progressbar', { name: 'Uploading big.bin' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(screen.getByRole('progressbar', { name: 'Uploading small.txt' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    // 6 of 10 bytes across both files.
    expect(screen.getByRole('button', { name: 'Uploading 60%' })).toBeDisabled();
    // Nothing can be added or removed mid-send.
    expect(screen.getByRole('button', { name: 'Remove big.bin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
  });

  it('waits for the uploads still running before reporting a failed one, then retries only it', async () => {
    const fetchImpl = perFileUploadsApi();
    const s3 = heldUploads();
    let badAttempts = 0;
    const onClose = renderWithUploads(fetchImpl, async (url, file, type, onProgress) => {
      if (url.endsWith('/bad.txt')) {
        badAttempts += 1;
        if (badAttempts === 1) {
          return 403;
        }
      }
      return s3.uploadImpl(url, file, type, onProgress);
    });
    fireEvent.change(screen.getByLabelText('Attach files', { selector: 'input' }), {
      target: {
        files: ['bad.txt', 'slow.txt'].map((name) => new File(['x'], name, { type: 'text/plain' })),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(s3.open.has('slow.txt')).toBe(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => s3.open.get('slow.txt')?.finish());
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be uploaded');
    expect(callsTo(fetchImpl, '/emails', 'POST')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    // Sending again uploads only the failed file; the finished one is reused.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(s3.open.has('bad.txt')).toBe(true));
    await act(async () => s3.open.get('bad.txt')?.finish());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const uploads = callsTo(fetchImpl, '/attachments/uploads', 'POST').map(
      (call) => JSON.parse(String(call[1]?.body)).filename,
    );
    expect(uploads.sort()).toEqual(['bad.txt', 'bad.txt', 'slow.txt']);
    const [[, sendInit]] = callsTo(fetchImpl, '/emails', 'POST');
    expect(JSON.parse(String(sendInit?.body)).attachments).toEqual([
      { uploadId: 'bad.txt' },
      { uploadId: 'slow.txt' },
    ]);
  });

  it('keeps the window open when an upload fails', async () => {
    const fetchImpl = uploadingApi();
    const base = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation(async (url, init) =>
      String(url).startsWith('https://mail-bucket.s3.')
        ? new Response(null, { status: 403 })
        : base!(url, init),
    );
    const compose = renderCompose({ from: 'me@x.com', to: 'a@y.com', html: '<p>x</p>' }, fetchImpl);
    attach(new File(['x'], 'a.txt', { type: 'text/plain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be uploaded');
    expect(callsTo(compose.fetchImpl, '/emails')).toHaveLength(0);
    expect(compose.onClose).not.toHaveBeenCalled();
  });
});

describe('ComposeWindow — send is not re-entrant', () => {
  it('sends once when ⌘↵ is pressed again while a send is in flight', async () => {
    let release: () => void = () => {};
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (pathOf(url) === '/me') {
        return json(200, { subject: 'owner' });
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json(200, { id: 'm1', messageId: 'ses-1', sentAt: '2026-07-17T00:00:00.000Z' });
    });
    const compose = renderCompose({ from: 'me@x.com', to: 'a@y.com', html: '<p>x</p>' }, fetchImpl);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(callsTo(fetchImpl, '/emails', 'POST')).toHaveLength(1));
    release();
    await waitFor(() => expect(compose.onClose).toHaveBeenCalled());
    expect(callsTo(fetchImpl, '/emails', 'POST')).toHaveLength(1);
  });
});

describe('ComposeWindow — drafts', () => {
  it('auto-saves to a browser draft while typing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderCompose({ from: 'me@x.com' });
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Draft me' } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(storedDrafts().map((d) => d.subject)).toEqual(['Draft me']);
      expect(screen.getByText('Draft saved')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a draft, with an undo that restores it', async () => {
    const compose = renderCompose({ draftId: 'd1', from: 'me@x.com', subject: 'Gone' });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Gone soon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));

    expect(compose.onClose).toHaveBeenCalled();
    expect(storedDrafts()).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(storedDrafts().map((d) => d.subject)).toEqual(['Gone soon']);
  });

  it('does not save an untouched blank window', () => {
    const compose = renderCompose({ from: 'me@x.com' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(compose.onClose).toHaveBeenCalled();
    expect(storedDrafts()).toEqual([]);
  });
});

describe('ComposeWindow — window controls', () => {
  it('minimizes to a bar and restores', () => {
    renderCompose({ from: 'me@x.com', subject: 'Status' });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('reveals Cc and Bcc on demand', () => {
    renderCompose({ from: 'me@x.com' });
    expect(screen.queryByLabelText('Cc')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cc Bcc' }));
    expect(screen.getByLabelText('Cc')).toBeInTheDocument();
    expect(screen.getByLabelText('Bcc')).toBeInTheDocument();
  });
});
