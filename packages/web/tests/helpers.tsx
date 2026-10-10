import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { UploadTransport } from '../src/api/client.js';
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

/**
 * An S3 upload transport that PUTs through the fetch mock, so a test sees uploads as fetch
 * calls. It reports the whole file sent once the PUT answers.
 */
export function uploadVia(fetchImpl: typeof fetch): UploadTransport {
  return async (url, file, contentType, onProgress) => {
    const response = await fetchImpl(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    onProgress(file.size);
    return response.status;
  };
}

/** Mount inside the providers the app mounts (auth, tooltips, toasts). */
export function renderWithApp(
  ui: React.ReactNode,
  fetchImpl: typeof fetch,
  uploadImpl: UploadTransport = uploadVia(fetchImpl),
) {
  return render(
    <AuthProvider apiBaseUrl="http://api.test" fetchImpl={fetchImpl} uploadImpl={uploadImpl}>
      <TooltipProvider>
        {ui}
        <Toaster />
      </TooltipProvider>
    </AuthProvider>,
  );
}
