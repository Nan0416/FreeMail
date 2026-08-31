import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/auth/auth-context.js';
import { AuthGate } from '../../src/components/AuthGate.js';

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
  if (path === '/me') {
    return json(403, { error: 'invalid_token', message: 'no session' });
  }
  if (path === '/auth/refresh') {
    return json(401, { error: 'invalid_token', message: 'no session' });
  }
  return null;
}

describe('AuthGate', () => {
  it('shows the sign-in form when there is no session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) {
        return res;
      }
      throw new Error(`unexpected ${new URL(String(url)).pathname}`);
    });
    renderGate(fetchMock);
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs in and shows the app shell', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) {
        return res;
      }
      if (new URL(String(url)).pathname === '/auth/login') {
        return json(200, { subject: 'owner' });
      }
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
      if (res) {
        return res;
      }
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') {
        return json(200, { subject: 'owner' });
      }
      // The revoke fails: only a 2xx clears the httpOnly cookies, so the session is live.
      if (path === '/auth/logout') {
        return json(500, { error: 'invalid_request', message: 'retry' });
      }
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

  it('signs straight in on a fresh deployment — one login call, no set-password step', async () => {
    // #42 trust-on-first-use: the server enrolls the submitted password and returns a
    // session, so the SPA needs no first-run screen and no second request.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) {
        return res;
      }
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') {
        return json(200, { subject: 'owner' });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a-strong-enough-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('heading', { name: 'Compose' });
    expect(screen.queryByRole('form', { name: 'Set password' })).not.toBeInTheDocument();
    const loginCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/auth/login',
    );
    expect(loginCalls).toHaveLength(1);
  });

  it('warns that the first password entered claims the account', async () => {
    // The SPA cannot detect first run (no unauthenticated "is a password set?" probe),
    // so the consequence is stated up front rather than discovered by mistyping it.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const res = noSession(url);
      if (res) {
        return res;
      }
      throw new Error(`unexpected ${new URL(String(url)).pathname}`);
    });
    renderGate(fetchMock);
    await screen.findByRole('form', { name: 'Sign in' });
    expect(screen.getByText(/becomes your account password/i)).toBeInTheDocument();
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
});
