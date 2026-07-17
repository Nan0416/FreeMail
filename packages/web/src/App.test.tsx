import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('mounts the sign-in screen once runtime config loads', async () => {
    const loadConfig = vi.fn().mockResolvedValue({ apiBaseUrl: 'http://api.test' });
    const fetchImpl = vi.fn<typeof fetch>();
    render(<App loadConfig={loadConfig} fetchImpl={fetchImpl} />);
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows a boot error when runtime config cannot be loaded', async () => {
    const loadConfig = vi.fn().mockRejectedValue(new Error('could not load /config.json'));
    render(<App loadConfig={loadConfig} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load /config.json');
  });
});
