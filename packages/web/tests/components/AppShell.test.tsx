import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { AppShell } from '../../src/components/AppShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderShell(inboundEnabled: boolean) {
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
  render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchMock}>
      <AppShell inboundEnabled={inboundEnabled} />
    </AuthProvider>,
  );
}

describe('AppShell — inbox gating', () => {
  it('shows the Inbox tab (and defaults to it) when inbound is enabled', async () => {
    renderShell(true);
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sent' })).toBeInTheDocument();
    // Defaults to the Inbox view.
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('hides the Inbox tab when inbound is disabled, but Sent still shows', async () => {
    renderShell(false);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument(),
    );
    // Sent history is always available; the shell defaults to Compose.
    expect(screen.getByRole('button', { name: 'Sent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Compose' })).toBeInTheDocument();
  });
});
