import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AuthProvider } from '../src/auth/auth-context.js';
import { Toaster } from '../src/components/ui/sonner.js';
import { TooltipProvider } from '../src/components/ui/tooltip.js';

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function pathOf(url: unknown): string {
  return new URL(String(url)).pathname;
}

/** Calls the mock made to one path (optionally one method). */
export function callsTo(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  path: string,
  method?: string,
): Parameters<typeof fetch>[] {
  return fetchMock.mock.calls.filter(
    ([url, init]) => pathOf(url) === path && (!method || (init?.method ?? 'GET') === method),
  );
}

/** Mount inside the providers the app mounts (auth, tooltips, toasts). */
export function renderWithApp(ui: React.ReactNode, fetchImpl: typeof fetch) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl}>
      <TooltipProvider>
        {ui}
        <Toaster />
      </TooltipProvider>
    </AuthProvider>,
  );
}
