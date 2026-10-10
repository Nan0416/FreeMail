import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpServerView, mcpJson } from '../../src/components/McpServerView.js';
import { json, renderWithApp } from '../helpers.js';

function renderPage(fetchImpl: typeof fetch) {
  return renderWithApp(<McpServerView />, fetchImpl);
}

const RAW_KEY = 'fm_kid1_thesecretpart';
const SUMMARY = { id: 'kid1', name: 'agent', createdAt: '2026-07-17T00:00:00.000Z' };

describe('McpServerView', () => {
  it('shows the server URL and a Claude Code .mcp.json that reads the key from the environment', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      return path === '/me' ? json(200, { subject: 'owner' }) : json(200, { keys: [] });
    });
    renderPage(fetchMock);

    expect(screen.getByTestId('mcp-server-url')).toHaveTextContent('http://api.test/mcp');
    expect(JSON.parse(screen.getByTestId('mcp-json').textContent ?? '')).toEqual({
      mcpServers: {
        freemail: {
          type: 'http',
          url: 'http://api.test/mcp',
          headers: { 'x-api-key': '${FREEMAIL_API_KEY}' },
        },
      },
    });
    await screen.findByText('No access keys yet.');
  });

  it('copies the server URL and the config', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      return path === '/me' ? json(200, { subject: 'owner' }) : json(200, { keys: [] });
    });
    renderPage(fetchMock);

    fireEvent.click(screen.getByRole('button', { name: 'Copy server URL' }));
    await screen.findByRole('button', { name: 'Copied' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy .mcp.json' }));
    await waitFor(() =>
      expect(writeText.mock.calls).toEqual([
        ['http://api.test/mcp'],
        [mcpJson('http://api.test/mcp')],
      ]),
    );
  });

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
    renderPage(fetchMock);

    await screen.findByText('No access keys yet.');
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    // the raw secret is revealed once
    const revealed = await screen.findByTestId('revealed-key');
    expect(revealed).toHaveTextContent(RAW_KEY);
    // the list row shows the id/name, never the raw secret
    const list = screen.getByRole('list', { name: 'Access keys' });
    expect(within(list).getByText('kid1')).toBeInTheDocument();
    expect(within(list).queryByText(RAW_KEY)).not.toBeInTheDocument();

    // dismiss → the secret is removed from the DOM (not merely hidden)
    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    await waitFor(() => expect(screen.queryByTestId('revealed-key')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(RAW_KEY);
  });

  it('revokes a key only after confirming in a dialog', async () => {
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
    renderPage(fetchMock);

    // Cancelling leaves the key alone.
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke agent?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(screen.getByText('No access keys yet.')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          new URL(String(url)).pathname === '/keys/kid1' && init?.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
