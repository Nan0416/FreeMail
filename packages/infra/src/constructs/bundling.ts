import type { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * esbuild options for every bundled (`NodejsFunction`) FreeMail Lambda: bundle EVERYTHING, the
 * AWS SDK v3 clients included. `NodejsFunction` otherwise leaves `@aws-sdk/*` external on
 * Node 18+ runtimes, so the function would run whatever SDK version the Lambda runtime ships
 * rather than the one the tests ran against — and the upload path depends on SDK behavior (the
 * presign client's checksum setting). Bundled, the deployed SDK is the lockfile's, and
 * esbuild's single tree-shaken file also loads faster than resolving the runtime's modules (as
 * in conduit). The metafile records what was bundled and what was left external — what
 * `tests/bundling.test.ts` checks.
 */
export const SELF_CONTAINED_BUNDLING: BundlingOptions = { externalModules: [], metafile: true };
