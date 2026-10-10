import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
