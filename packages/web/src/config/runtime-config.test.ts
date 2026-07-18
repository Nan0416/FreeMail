import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from './runtime-config.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('loadRuntimeConfig', () => {
  it('loads and normalizes /config.json', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(200, { apiBaseUrl: 'https://api.example.com/', inboundEnabled: true }),
      );
    await expect(loadRuntimeConfig(fetchMock)).resolves.toEqual({
      apiBaseUrl: 'https://api.example.com',
      inboundEnabled: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/config.json');
    expect(init?.cache).toBe('no-store');
  });

  it('defaults inboundEnabled to false when the deployed config omits it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(200, { apiBaseUrl: 'https://api.example.com' }));
    await expect(loadRuntimeConfig(fetchMock)).resolves.toEqual({
      apiBaseUrl: 'https://api.example.com',
      inboundEnabled: false,
    });
  });

  it('fails loud on a malformed deployed config.json', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(200, { nope: true }));
    await expect(loadRuntimeConfig(fetchMock)).rejects.toThrow(/apiBaseUrl/);
  });

  it('throws when config.json is unreachable and no dev fallback is set', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(loadRuntimeConfig(fetchMock)).rejects.toThrow(/could not load \/config\.json/);
  });
});
