import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  it('mounts the sign-in screen once runtime config loads', async () => {
    const loadConfig = vi.fn().mockResolvedValue({ apiBaseUrl: '/api' });
    // The boot session probe finds no session (denied `/me`, failed cookie refresh).
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url), 'http://local').pathname;
      const status = path === '/api/me' ? 403 : 401;
      return new Response(JSON.stringify({ error: 'invalid_token', message: 'no session' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(<App loadConfig={loadConfig} fetchImpl={fetchImpl} />);
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows a boot error when runtime config cannot be loaded', async () => {
    const loadConfig = vi.fn().mockRejectedValue(new Error('could not load /config.json'));
    render(<App loadConfig={loadConfig} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load /config.json');
  });
});
