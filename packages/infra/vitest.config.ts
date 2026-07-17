import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test synthesizes the stack, which bundles the Lambda handlers with
    // esbuild at synth time. The MCP handler pulls in the MCP SDK, so the first
    // synth() is slow (subsequent ones reuse the bundling cache); the default 5s
    // per-test timeout is too tight for that first build.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
