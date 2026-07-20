import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { MailListView } from '../../src/components/MailListView.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderInbox(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl}>
      <MailListView direction="inbound" title="Inbox" emptyMessage="No messages yet." />
    </AuthProvider>,
  );
}

const INBOUND_ROW = {
  id: 'h1',
  direction: 'inbound',
  from: 'sender@x.com',
  fromName: 'Ada Sender',
  to: ['me@y.com'],
  cc: [],
  subject: 'Meeting notes',
  snippet: 'here are the notes',
  date: '2026-07-17T00:00:00.000Z',
  hasAttachments: true,
  attachmentCount: 1,
  quarantined: false,
};

describe('MailListView', () => {
  it('lists inbound rows with sender, subject, and attachment indicator', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (parsed.pathname === '/emails') {
        expect(parsed.searchParams.get('direction')).toBe('inbound');
        return json(200, { emails: [INBOUND_ROW] });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    renderInbox(fetchMock);

    const list = await screen.findByRole('list', { name: 'Inbox' });
    expect(within(list).getByText('Ada Sender')).toBeInTheDocument();
    expect(within(list).getByText('Meeting notes')).toBeInTheDocument();
    expect(within(list).getByLabelText('Has attachments')).toBeInTheDocument();
  });

  it('shows the empty state when there are no messages', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (path === '/emails') {
        return json(200, { emails: [] });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderInbox(fetchMock);
    expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
  });

  it('flags a quarantined row', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (path === '/emails') {
        return json(200, { emails: [{ ...INBOUND_ROW, quarantined: true, spamVerdict: 'FAIL' }] });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderInbox(fetchMock);
    expect(await screen.findByText('Quarantined')).toBeInTheDocument();
  });

  it('opens a message in the reader when a row is clicked', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (path === '/emails') {
        return json(200, { emails: [INBOUND_ROW] });
      }
      if (path === '/emails/h1') {
        return json(200, {
          ...INBOUND_ROW,
          text: 'the full body',
          attachments: [],
          bcc: undefined,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderInbox(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /Meeting notes/ }));
    expect(await screen.findByText('the full body')).toBeInTheDocument();
    // The reader offers a way back to the list.
    expect(screen.getByRole('button', { name: '← Back' })).toBeInTheDocument();
  });

  it('paginates with Load more (appends the next page and drops the button when exhausted)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (parsed.pathname === '/emails') {
        return parsed.searchParams.get('cursor') === 'c2'
          ? json(200, { emails: [{ ...INBOUND_ROW, id: 'h2', subject: 'Second' }] })
          : json(200, { emails: [INBOUND_ROW], nextCursor: 'c2' });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    renderInbox(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Meeting notes')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument(),
    );
  });
});
