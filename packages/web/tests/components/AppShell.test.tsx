import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailListItem } from '@freemail/shared';
import { AppShell } from '../../src/components/AppShell.js';
import { resetDraftsCache } from '../../src/lib/drafts.js';
import { callsTo, json, pathOf, renderWithApp } from '../helpers.js';

function item(id: string, over: Partial<EmailListItem> = {}): EmailListItem {
  return {
    id,
    direction: 'inbound',
    from: `${id}@x.com`,
    to: ['me@y.com'],
    cc: [],
    subject: `Subject ${id}`,
    snippet: `snippet ${id}`,
    date: '2026-07-17T00:00:00.000Z',
    hasAttachments: false,
    attachmentCount: 0,
    ...over,
  };
}

const DETAIL_EXTRA = { attachments: [], sizeBytes: 10, text: 'body text' };

/** `/me`, `/emails` (paged by the given pages), and `/emails/:id` from those rows. */
function mockApi(pages: readonly (readonly EmailListItem[])[]) {
  const all = pages.flat();
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === '/me') {
      return json(200, { subject: 'owner' });
    }
    if (u.pathname === '/emails' && (init?.method ?? 'GET') === 'GET') {
      const page = Number(u.searchParams.get('cursor') ?? 0);
      return json(200, {
        emails: pages[page] ?? [],
        ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
      });
    }
    const match = u.pathname.match(/^\/emails\/([^/]+)$/);
    const found = match && all.find((e) => e.id === match[1]);
    if (found) {
      return json(200, { ...found, ...DETAIL_EXTRA });
    }
    throw new Error(`unexpected ${u.pathname}`);
  });
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Inbox' })).getAllByRole('listitem');
}

beforeEach(() => {
  window.localStorage.clear();
  resetDraftsCache();
});

describe('AppShell — folders', () => {
  it('shows Inbox and defaults to it when inbound is enabled', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[]]));
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sent' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
    expect(await screen.findByText('Your inbox is empty.')).toBeInTheDocument();
  });

  it('hides Inbox and All mail when inbound is disabled, and defaults to Sent', async () => {
    const fetchMock = mockApi([[]]);
    renderWithApp(<AppShell />, fetchMock);
    expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All mail' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Errors' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Sent' })).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, '/emails')).toHaveLength(1));
    expect(new URL(String(callsTo(fetchMock, '/emails')[0][0])).searchParams.get('direction')).toBe(
      'sent',
    );
  });

  it('lists the merged timeline in All mail (no direction filter)', async () => {
    const fetchMock = mockApi([[item('a')]]);
    renderWithApp(<AppShell inboundEnabled />, fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'All mail' }));
    expect(await screen.findByRole('heading', { name: 'All mail' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        callsTo(fetchMock, '/emails').some(
          ([url]) => !new URL(String(url)).searchParams.has('direction'),
        ),
      ).toBe(true),
    );
  });
});

describe('AppShell — Errors folder', () => {
  it('lists failed mail under Errors, tagged with why it failed', async () => {
    const fetchMock = mockApi([
      [
        item('v', { failed: true, quarantined: true, virusVerdict: 'FAIL' }),
        item('p', {
          failed: true,
          quarantined: true,
          virusVerdict: 'PASS',
          parseStatus: 'oversize',
        }),
      ],
    ]);
    renderWithApp(<AppShell inboundEnabled />, fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));

    expect(await screen.findByRole('heading', { name: 'Errors' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        callsTo(fetchMock, '/emails').some(
          ([url]) => new URL(String(url)).searchParams.get('direction') === 'failed',
        ),
      ).toBe(true),
    );
    const list = within(await screen.findByRole('list', { name: 'Errors' }));
    expect(await list.findByText('Virus')).toBeInTheDocument();
    expect(list.getByText('Too large')).toBeInTheDocument();
    // Failure tags replace the generic Spam tag.
    expect(list.queryByText('Spam')).not.toBeInTheDocument();
  });
});

describe('AppShell — message list', () => {
  it('renders rows with sender, subject, attachment and spam markers', async () => {
    renderWithApp(
      <AppShell inboundEnabled />,
      mockApi([
        [
          item('a', { fromName: 'Alice', hasAttachments: true, attachmentCount: 1 }),
          item('b', { quarantined: true }),
        ],
      ]),
    );
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Subject a')).toBeInTheDocument();
    expect(screen.getByLabelText('Has attachments')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('Spam')).toBeInTheDocument();
  });

  it('opens a message in the reading pane when a row is clicked', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[item('a'), item('b')]]));
    fireEvent.click(await screen.findByText('Subject b'));
    const reader = await screen.findByRole('article', { name: 'Message' });
    expect(await within(reader).findByRole('heading', { name: 'Subject b' })).toBeInTheDocument();
    expect(within(reader).getByText('body text')).toBeInTheDocument();
  });

  it('paginates with Load more and drops the button when exhausted', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[item('a')], [item('b')]]));
    await screen.findByText('Subject a');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Subject b')).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('searches the loaded messages', async () => {
    renderWithApp(
      <AppShell inboundEnabled />,
      mockApi([[item('a', { subject: 'Quarterly report' }), item('b', { subject: 'Lunch' })]]),
    );
    await screen.findByText('Quarterly report');
    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'quarter' } });
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText('Lunch')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'zzz' } });
    expect(screen.getByText('No loaded messages match.')).toBeInTheDocument();
  });

  it('moves the selection with j / k and closes the reader with Escape', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[item('a'), item('b'), item('c')]]));
    await screen.findByText('Subject a');

    fireEvent.keyDown(window, { key: 'j' });
    expect(await screen.findByRole('heading', { name: 'Subject a', level: 2 })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j' });
    expect(await screen.findByRole('heading', { name: 'Subject b', level: 2 })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k' });
    expect(await screen.findByRole('heading', { name: 'Subject a', level: 2 })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('article', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('ignores shortcuts typed into a field', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[item('a')]]));
    await screen.findByText('Subject a');
    fireEvent.keyDown(screen.getByLabelText('Search messages'), { key: 'j' });
    expect(screen.queryByRole('article', { name: 'Message' })).not.toBeInTheDocument();
  });
});

describe('AppShell — refresh', () => {
  it('keeps the loaded rows when a refresh fails, and reports it', async () => {
    let failNext = false;
    const base = mockApi([[item('a')], [item('b')]]);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/emails' && !u.searchParams.has('cursor') && failNext) {
        throw new TypeError('network down');
      }
      return base(url, init);
    });
    renderWithApp(<AppShell inboundEnabled />, fetchMock);
    await screen.findByText('Subject a');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Subject b');

    failNext = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(/Could not refresh/)).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('does not leave Refresh stuck when the folder changes mid-refresh', async () => {
    let hang = false;
    const base = mockApi([[item('a')]]);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (hang && new URL(String(url)).searchParams.get('direction') === 'inbound') {
        return new Promise<Response>(() => {});
      }
      return base(url, init);
    });
    renderWithApp(<AppShell inboundEnabled />, fetchMock);
    await screen.findByText('Subject a');

    hang = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    await screen.findByRole('heading', { name: 'Sent' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });
});

describe('AppShell — compose', () => {
  it('opens a compose window with c and prefills reply from the open message', async () => {
    renderWithApp(
      <AppShell inboundEnabled />,
      mockApi([[item('a', { from: 'alice@x.com', subject: 'Plans' })]]),
    );
    await screen.findByText('Plans');
    fireEvent.click(screen.getByText('Plans'));
    await screen.findByRole('heading', { name: 'Plans', level: 2 });

    fireEvent.keyDown(window, { key: 'r' });
    const dialog = await screen.findByRole('dialog', { name: 'Re: Plans' });
    expect(within(dialog).getByLabelText('To')).toHaveValue('alice@x.com');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Re: Plans');
  });

  it('refuses to replace an open compose that has attachments', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[]]));
    fireEvent.keyDown(window, { key: 'c' });
    const dialog = await screen.findByRole('dialog', { name: 'New message' });
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'With file' } });
    const picker = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File(['data'], 'report.pdf', { type: 'application/pdf' })] },
    });
    expect(within(dialog).getByText('report.pdf')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'c' });
    expect(await screen.findByText('Finish your open message first')).toBeInTheDocument();
    // The original window, and its attachment, are untouched.
    expect(screen.getByRole('dialog', { name: 'With file' })).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('keeps a closed compose as a browser draft, listed under Drafts', async () => {
    renderWithApp(<AppShell inboundEnabled />, mockApi([[]]));
    fireEvent.keyDown(window, { key: 'c' });
    const dialog = await screen.findByRole('dialog', { name: 'New message' });
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Later' } });
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    });
    expect(await screen.findByText('Draft saved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Drafts/ }));
    const drafts = await screen.findByRole('list', { name: 'Drafts' });
    expect(within(drafts).getByText('Later')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('freemail.drafts.v1') ?? '[]')).toHaveLength(1);
  });
});

it('opens the API keys page from the sidebar', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const path = pathOf(url);
    if (path === '/me') {
      return json(200, { subject: 'owner' });
    }
    if (path === '/keys') {
      return json(200, { keys: [] });
    }
    return json(200, { emails: [] });
  });
  renderWithApp(<AppShell inboundEnabled />, fetchMock);
  fireEvent.click(screen.getByRole('button', { name: 'API keys' }));
  expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
});
