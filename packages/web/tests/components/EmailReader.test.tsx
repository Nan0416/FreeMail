import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailReader } from '../../src/components/EmailReader.js';
import { json, renderWithApp } from '../helpers.js';

const BASE_INBOUND = {
  id: 'h1',
  direction: 'inbound' as const,
  from: 'a@x.com',
  to: ['me@y.com'],
  cc: [],
  subject: 'Hello',
  date: '2026-07-17T00:00:00.000Z',
  attachments: [],
  hasAttachments: false,
  attachmentCount: 0,
  sizeBytes: 100,
};

/** Mock `/me` (boot probe) + `/emails/h1` returning the given detail; extra routes optional. */
function mockReader(detail: unknown, extra?: (path: string) => Response | null): typeof fetch {
  return vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/me') {
      return json(200, { subject: 'owner' });
    }
    if (path === '/emails/h1') {
      return json(200, detail);
    }
    const e = extra?.(path);
    if (e) {
      return e;
    }
    throw new Error(`unexpected ${path}`);
  });
}

function renderReader(fetchImpl: typeof fetch, onReply = vi.fn()) {
  return renderWithApp(<EmailReader id="h1" onBack={vi.fn()} onReply={onReply} />, fetchImpl);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmailReader — body matrix', () => {
  it('renders a SENT message body (text) with its bcc and no status notice once sent', async () => {
    renderReader(
      mockReader({
        ...BASE_INBOUND,
        direction: 'sent',
        status: 'sent',
        subject: 'My sent mail',
        bcc: ['secret@z.com'],
        text: 'what I wrote',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'My sent mail' })).toBeInTheDocument();
    expect(screen.getByText('what I wrote')).toBeInTheDocument();
    expect(screen.getByText('secret@z.com')).toBeInTheDocument();
    expect(screen.queryByText(/only its metadata/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders a SENT HTML body in the same sandbox, with images allowed (our own mail)', async () => {
    renderReader(
      mockReader({ ...BASE_INBOUND, direction: 'sent', status: 'sent', html: '<p>sent-html</p>' }),
    );
    const frame = await screen.findByTitle('Email content');
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('srcdoc')).toContain('img-src https:');
    expect(screen.queryByRole('button', { name: 'Show images' })).not.toBeInTheDocument();
  });

  it('flags a send_failed message but still shows the archived body', async () => {
    renderReader(
      mockReader({ ...BASE_INBOUND, direction: 'sent', status: 'send_failed', text: 'draft body' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/failed to send/i);
    expect(screen.getByText('draft body')).toBeInTheDocument();
  });

  it('falls back to the no-body note for a sent message without a stored body', async () => {
    renderReader(mockReader({ ...BASE_INBOUND, direction: 'sent' }));
    expect(await screen.findByText(/no readable body/i)).toBeInTheDocument();
  });

  it('renders inbound HTML in a locked-down sandboxed iframe with images blocked by default', async () => {
    renderReader(mockReader({ ...BASE_INBOUND, html: '<p>hello-html</p>' }));
    const frame = await screen.findByTitle('Email content');
    // The sandbox is the isolation control: NEVER allow-same-origin / allow-scripts.
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    // The per-email CSP blocks images until the user opts in.
    expect(frame.getAttribute('srcdoc')).toContain("img-src 'none'");
    expect(screen.getByRole('button', { name: 'Show images' })).toBeInTheDocument();
  });

  it('renders inbound plain text without an iframe', async () => {
    renderReader(mockReader({ ...BASE_INBOUND, text: 'just plain body' }));
    expect(await screen.findByText('just plain body')).toBeInTheDocument();
    expect(screen.queryByTitle('Email content')).not.toBeInTheDocument();
  });
});

describe('EmailReader — image toggle', () => {
  it('re-renders the iframe with img-src https: when images are shown', async () => {
    renderReader(mockReader({ ...BASE_INBOUND, html: '<img src="https://cdn.example/x.png">' }));
    const frame = await screen.findByTitle('Email content');
    expect(frame.getAttribute('srcdoc')).toContain("img-src 'none'");

    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    await waitFor(() =>
      expect(screen.getByTitle('Email content').getAttribute('srcdoc')).toContain('img-src https:'),
    );
    // The inline prompt goes away; re-blocking lives in the More actions menu.
    expect(screen.queryByRole('button', { name: 'Show images' })).not.toBeInTheDocument();
  });
});

describe('EmailReader — quarantine gating', () => {
  it('hides a spam body behind a reveal, then shows it through the same render path', async () => {
    renderReader(
      mockReader({
        ...BASE_INBOUND,
        quarantined: true,
        spamVerdict: 'FAIL',
        virusVerdict: 'PASS',
        text: 'the spam body',
      }),
    );
    expect(await screen.findByText(/flagged as spam/i)).toBeInTheDocument();
    expect(screen.queryByText('the spam body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show message' }));
    expect(await screen.findByText('the spam body')).toBeInTheDocument();
  });

  it('shows NO reveal for a virus-failed message (no body exists)', async () => {
    renderReader(
      mockReader({ ...BASE_INBOUND, quarantined: true, virusVerdict: 'FAIL', spamVerdict: 'PASS' }),
    );
    expect(await screen.findByText(/failed a virus scan/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show message' })).not.toBeInTheDocument();
  });
});

describe('EmailReader — attachment download', () => {
  it('mints a presigned URL and triggers a browser download without leaving the app', async () => {
    let clickedHref = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedHref = this.href;
    });

    const fetchMock = mockReader(
      {
        ...BASE_INBOUND,
        text: 'body',
        hasAttachments: true,
        attachmentCount: 1,
        attachments: [
          { id: 'a1', filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
        ],
      },
      (path) =>
        path === '/emails/h1/attachments/a1'
          ? json(200, { url: 'https://s3.example/signed', expiresAt: '2026-07-17T00:01:00.000Z' })
          : null,
    );
    renderReader(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Download report.pdf' }));
    await waitFor(() => expect(clickedHref).toBe('https://s3.example/signed'));
    expect(
      (fetchMock as ReturnType<typeof vi.fn>).mock.calls.some(
        ([url]) => new URL(String(url)).pathname === '/emails/h1/attachments/a1',
      ),
    ).toBe(true);
  });
});

describe('EmailReader — download original (.eml)', () => {
  it('offers it in More actions when rawAvailable, and downloads via a minted URL', async () => {
    let clickedHref = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedHref = this.href;
    });
    renderReader(
      mockReader({ ...BASE_INBOUND, text: 'body', rawAvailable: true }, (path) =>
        path === '/emails/h1/raw'
          ? json(200, { url: 'https://s3.example/raw', expiresAt: '2026-07-17T00:01:00.000Z' })
          : null,
      ),
    );
    await screen.findByRole('heading', { name: 'Hello' });

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download original (.eml)' }));

    await waitFor(() => expect(clickedHref).toBe('https://s3.example/raw'));
  });

  it('hides it when the original is not available', async () => {
    renderReader(mockReader({ ...BASE_INBOUND, text: 'body', rawAvailable: false }));
    await screen.findByRole('heading', { name: 'Hello' });

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    await screen.findByRole('menuitem', { name: 'Copy sender address' });
    expect(
      screen.queryByRole('menuitem', { name: 'Download original (.eml)' }),
    ).not.toBeInTheDocument();
  });
});

describe('EmailReader — actions', () => {
  it('hands the loaded message to reply, reply-all and forward', async () => {
    const onReply = vi.fn();
    renderReader(mockReader({ ...BASE_INBOUND, text: 'body' }), onReply);
    await screen.findByRole('heading', { name: 'Hello' });

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reply all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));

    expect(onReply.mock.calls.map(([email, mode]) => [email.id, mode])).toEqual([
      ['h1', 'reply'],
      ['h1', 'replyAll'],
      ['h1', 'forward'],
    ]);
  });

  it('disables the actions until the message has loaded', () => {
    renderReader(mockReader({ ...BASE_INBOUND, text: 'body' }));
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
  });
});
