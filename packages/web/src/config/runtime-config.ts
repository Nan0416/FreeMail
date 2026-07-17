import { parseWebRuntimeConfig, type WebRuntimeConfig } from '@freemail/shared';

/**
 * Load the deploy-time runtime config the CDK wrote to `/config.json`. The API
 * endpoint is a CloudFormation value baked in at deploy, not at build, so it is
 * fetched at boot rather than compiled into the bundle.
 *
 * A present-but-malformed `config.json` fails loud (surfaces as a boot error). A
 * missing/unreachable one only happens in local `vite dev` (no deploy), where we
 * fall back to the `VITE_API_BASE_URL` dev env var if set.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<WebRuntimeConfig> {
  let response: Response | null = null;
  try {
    response = await fetchImpl('/config.json', { cache: 'no-store' });
  } catch {
    // Network failure — no deployed config.json (dev). Fall through to the dev env.
    response = null;
  }

  if (response && response.ok) {
    // Fail-loud on a malformed deployed config rather than silently using a default.
    return parseWebRuntimeConfig(await response.json());
  }

  const devBaseUrl = import.meta.env.VITE_API_BASE_URL;
  if (typeof devBaseUrl === 'string' && devBaseUrl.trim().length > 0) {
    return parseWebRuntimeConfig({ apiBaseUrl: devBaseUrl });
  }

  throw new Error(
    'FreeMail: could not load /config.json and VITE_API_BASE_URL is not set. ' +
      'The API endpoint is unknown.',
  );
}
