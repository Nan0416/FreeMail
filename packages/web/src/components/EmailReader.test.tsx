import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/auth-context.js';
import { EmailReader } from './EmailReader.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
    if (path === '/me') return json(200, { subject: 'owner' });
    if (path === '/emails/h1') return json(200, detail);
    const e = extra?.(path);
    if (e) return e;
    throw new Error(`unexpected ${path}`);
  });
}

function renderReader(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl}>
      <EmailReader id="h1" onBack={vi.fn()} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmailReader — body matrix', () => {
  it('renders a SENT message as metadata-only (no body)', async () => {
    renderReader(
      mockReader({
        ...BASE_INBOUND,
        direction: 'sent',
        subject: 'My sent mail',
        bcc: ['secret@z.com'],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'My sent mail' })).toBeInTheDocument();
    expect(screen.getByText(/metadata only/i)).toBeInTheDocument();
    expect(screen.getByText('secret@z.com')).toBeInTheDocument();
    expect(screen.queryByTitle('Email content')).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Hide images' })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(clickedHref).toBe('https://s3.example/signed'));
    expect(
      (fetchMock as ReturnType<typeof vi.fn>).mock.calls.some(
        ([url]) => new URL(String(url)).pathname === '/emails/h1/attachments/a1',
      ),
    ).toBe(true);
  });
});
