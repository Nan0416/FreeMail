import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { KeysView } from '../../src/components/KeysView.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderKeys(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl}>
      <KeysView />
    </AuthProvider>,
  );
}

const RAW_KEY = 'fm_kid1_thesecretpart';
const SUMMARY = { id: 'kid1', name: 'agent', createdAt: '2026-07-17T00:00:00.000Z' };

describe('KeysView', () => {
  it('shows a created key exactly once and clears it from the DOM on dismiss', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (path === '/keys' && (init?.method ?? 'GET') === 'GET') {
        return json(200, { keys: [] });
      }
      if (path === '/keys' && init?.method === 'POST') {
        return json(201, { ...SUMMARY, key: RAW_KEY });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    renderKeys(fetchMock);

    await screen.findByText('No API keys yet.');
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    // the raw secret is revealed once
    const revealed = await screen.findByTestId('revealed-key');
    expect(revealed).toHaveTextContent(RAW_KEY);
    // the list row shows the id/name, never the raw secret
    const list = screen.getByRole('list', { name: 'API keys' });
    expect(within(list).getByText('kid1')).toBeInTheDocument();
    expect(within(list).queryByText(RAW_KEY)).not.toBeInTheDocument();

    // dismiss → the secret is removed from the DOM (not merely hidden)
    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    await waitFor(() => expect(screen.queryByTestId('revealed-key')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(RAW_KEY);
  });

  it('revokes a key after an inline confirm', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/me') {
        return json(200, { subject: 'owner' });
      }
      if (path === '/keys' && (init?.method ?? 'GET') === 'GET') {
        return json(200, { keys: [SUMMARY] });
      }
      if (path === '/keys/kid1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    renderKeys(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByText('No API keys yet.')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          new URL(String(url)).pathname === '/keys/kid1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
