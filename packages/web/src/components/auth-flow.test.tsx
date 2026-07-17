import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/auth-context.js';
import { AuthGate } from './AuthGate.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderGate(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl}>
      <AuthGate />
    </AuthProvider>,
  );
}

/** The boot probe finds no session: `/me` is denied and the cookie refresh fails. */
function noSession(url: unknown): Response | null {
  const path = new URL(String(url)).pathname;
  if (path === '/me') return json(403, { error: 'invalid_token', message: 'no session' });
  if (path === '/auth/refresh') return json(401, { error: 'invalid_token', message: 'no session' });
  return null;
}

describe('AuthGate', () => {
  it('shows the sign-in form when there is no session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) return res;
      throw new Error(`unexpected ${new URL(String(url)).pathname}`);
    });
    renderGate(fetchMock);
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs in and shows the app shell', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) return res;
      if (new URL(String(url)).pathname === '/auth/login') return json(200, { subject: 'owner' });
      throw new Error(`unexpected ${new URL(String(url)).pathname}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a-strong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as owner')).toBeInTheDocument();
  });

  it('keeps the session and surfaces a retriable error when sign-out fails', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) return res;
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, { subject: 'owner' });
      // The revoke fails: only a 2xx clears the httpOnly cookies, so the session is live.
      if (path === '/auth/logout') return json(500, { error: 'invalid_request', message: 'retry' });
      throw new Error(`unexpected ${path}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a-strong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Compose' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    // The failure is surfaced, and the app shell stays — never a false sign-out.
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed');
    expect(screen.getByRole('heading', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('flips to first-run set-password when the server reports password_not_set', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) return res;
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') {
        return json(400, { error: 'password_not_set', message: 'no password yet' });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'whatever-value' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('form', { name: 'Set password' })).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });

  it('shows an error on invalid credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(401, { error: 'invalid_credentials', message: 'wrong password' }),
    );
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a-strong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('wrong password');
  });

  it('validates matching passwords before first-run set-password', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) return res;
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') {
        return json(400, { error: 'password_not_set', message: 'no password yet' });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'first-attempt-pw' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('form', { name: 'Set password' });

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'does-not-match-this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set password & sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    // only the login call happened; the mismatch was caught client-side
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => new URL(String(url)).pathname === '/auth/set-password',
        ),
      ).toHaveLength(0),
    );
  });
});
