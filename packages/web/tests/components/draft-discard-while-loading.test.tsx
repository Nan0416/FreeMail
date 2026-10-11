import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from '../../src/components/AppShell.js';
import { resetDraftsCache } from '../../src/lib/drafts.js';
import { json, pathOf, renderWithApp } from '../helpers.js';

// Its own file: the compose window's code loads once per module graph, so this must be the
// first compose opened in it.

beforeEach(() => {
  window.localStorage.clear();
  resetDraftsCache();
});

it('discarding a draft whose window is still loading keeps that window from opening it', async () => {
  window.localStorage.setItem(
    'freemail.drafts.v1',
    JSON.stringify([
      {
        id: 'd1',
        from: 'me@x.com',
        to: 'a@y.com',
        cc: '',
        bcc: '',
        subject: 'Plans',
        html: '<p>hi</p>',
        updatedAt: '2026-10-10T00:00:00.000Z',
      },
    ]),
  );
  const fetchMock = vi.fn<typeof fetch>(async (url) =>
    pathOf(url) === '/me' ? json(200, { subject: 'owner' }) : json(200, { emails: [] }),
  );
  renderWithApp(<AppShell inboundEnabled />, fetchMock);
  fireEvent.click(screen.getByRole('button', { name: /Drafts/ }));
  const drafts = screen.getByRole('list', { name: 'Drafts' });

  fireEvent.click(within(drafts).getByText('Plans'));
  // The window's code is still loading: discard before it renders.
  fireEvent.click(within(drafts).getByRole('button', { name: 'Discard draft' }));
  await act(async () => {
    await import('../../src/components/ComposeWindow.js');
  });

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(JSON.parse(window.localStorage.getItem('freemail.drafts.v1') ?? '[]')).toEqual([]);
});
