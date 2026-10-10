import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      // Almost every test synthesizes the whole stack, and bundling runs esbuild once per
      // Lambda per synth — dozens of CPU-bound builds that, on a small CI runner, starved
      // vitest's own workers into an RPC timeout (`Timeout calling "onTaskUpdate"`). CDK's
      // standard switch skips bundling for every stack (the value the CLI passes for `cdk ls`
      // or `cdk destroy`); only the Lambda asset hashes differ, which no test asserts.
      // `tests/bundling.test.ts` opts back in once, so the real bundles are still built and
      // checked.
      CDK_CONTEXT_JSON: JSON.stringify({ 'aws:cdk:bundling-stacks': [] }),
    },
    // Synthesizing a whole stack is slow on a small CI runner, and the bundling test's
    // `beforeAll` also builds every handler (the MCP SDK and AWS SDK included).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
