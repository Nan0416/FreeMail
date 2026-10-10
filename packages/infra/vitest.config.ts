import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Almost every test synthesizes the whole stack, and bundling runs esbuild once per
      // Lambda per synth — dozens of CPU-bound builds that, on a small CI runner, starved
      // vitest's own workers into an RPC timeout (`Timeout calling "onTaskUpdate"`). CDK's
      // standard switch skips bundling for every stack (as `cdk synth --exclusively` does);
      // the template under test is unchanged. `tests/bundling.test.ts` opts back in once, so
      // the real bundles are still built and checked.
      CDK_CONTEXT_JSON: JSON.stringify({ 'aws:cdk:bundling-stacks': [] }),
    },
    // The one real-bundling test builds every handler (the MCP SDK and AWS SDK included).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
