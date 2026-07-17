import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTokenStore } from '../api/token-store.js';
import { AuthProvider } from '../auth/auth-context.js';
import { AuthGate } from './AuthGate.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderGate(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider
      apiBaseUrl="http://api.test"
      fetchImpl={fetchImpl}
      tokenStore={createTokenStore(memoryStorage())}
    >
      <AuthGate />
    </AuthProvider>,
  );
}

const PAIR = { tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresIn: 900 };

describe('AuthGate', () => {
  it('shows the sign-in form when there is no session', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    renderGate(fetchMock);
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in and shows the app shell', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login') return json(200, PAIR);
      if (path === '/me') return json(200, { subject: 'owner' });
      throw new Error(`unexpected ${path}`);
    });
    renderGate(fetchMock);

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a-strong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Compose' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as owner')).toBeInTheDocument();
  });

  it('flips to first-run set-password when the server reports password_not_set', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
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
