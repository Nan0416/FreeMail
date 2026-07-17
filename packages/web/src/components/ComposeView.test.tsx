import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createTokenStore } from '../api/token-store.js';
import { AuthProvider } from '../auth/auth-context.js';
import { ComposeView } from './ComposeView.js';

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

function renderCompose(fetchImpl: typeof fetch) {
  return render(
    <AuthProvider
      apiBaseUrl="http://api.test"
      fetchImpl={fetchImpl}
      tokenStore={createTokenStore(memoryStorage())}
    >
      <ComposeView />
    </AuthProvider>,
  );
}

describe('ComposeView', () => {
  it('requires at least one recipient before sending', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    renderCompose(fetchMock);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'me@x.com' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at least one recipient');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the composed email and reports the message id', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(200, { id: 'm1', messageId: 'ses-123', sentAt: '2026-07-17T00:00:00.000Z' }),
    );
    renderCompose(fetchMock);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'me@x.com' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'a@y.com, b@y.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('status')).toHaveTextContent('ses-123');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/emails');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'me@x.com',
      to: ['a@y.com', 'b@y.com'],
      subject: 'Hi',
      text: 'hello there',
    });
  });
});
