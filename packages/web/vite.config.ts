/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { parseFreeMailConfig, type FreeMailConfig } from '@freemail/shared/config';

/** Same-origin path the dev server proxies to the deployed API. */
const DEV_API_PATH = '/api';

const DEPLOY_CONFIG_PATH = fileURLToPath(new URL('../../freemail-config.json', import.meta.url));

function loadDeployConfig(): FreeMailConfig | null {
  if (!existsSync(DEPLOY_CONFIG_PATH)) {
    return null;
  }
  return parseFreeMailConfig(JSON.parse(readFileSync(DEPLOY_CONFIG_PATH, 'utf8')));
}

/**
 * `vite dev` against the deployed (Lambda) API. The SPA is served on `localhost`, which
 * the API's exact-origin CORS policy refuses and whose site the `SameSite=Strict` session
 * cookies are not sent to. So instead of calling the api domain cross-origin, the dev
 * server serves a `/config.json` pointing the SPA at the same-origin `/api` and proxies
 * that to the api domain: the browser only ever talks to `localhost`, and the `__Host-`
 * cookies the API sets land on `localhost`.
 */
function devAgainstDeployedApi(config: FreeMailConfig): Plugin {
  const runtimeConfig = JSON.stringify({
    apiBaseUrl: DEV_API_PATH,
    inboundEnabled: config.inbound.enabled,
  });
  return {
    name: 'freemail-dev-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(runtimeConfig);
      });
    },
    config() {
      return {
        server: {
          proxy: {
            [DEV_API_PATH]: {
              target: `https://${config.apiDomain}`,
              changeOrigin: true,
              rewrite: (path) => path.slice(DEV_API_PATH.length),
              configure(proxy) {
                // Present as the deployed app, the one origin the API allows.
                proxy.on('proxyReq', (proxyReq) => {
                  if (proxyReq.getHeader('origin')) {
                    proxyReq.setHeader('origin', `https://${config.appDomain}`);
                  }
                });
              },
            },
          },
        },
      };
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // Vitest also runs as 'serve'; only a real dev server talks to the deployed API.
  const deployConfig = command === 'serve' && mode !== 'test' ? loadDeployConfig() : null;
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(deployConfig ? [devAgainstDeployedApi(deployConfig)] : []),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test-setup.ts',
      css: false,
    },
  };
});
