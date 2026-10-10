import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import type { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared/config';
import { FreeMailStack } from '../src/freemail-stack.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  sesIdentity: { mode: 'create' },
  // Inbound on, so the parser is built too.
  inbound: { enabled: true, confirmInboundMx: true },
};

/** Node builtins a bundle may import without the `node:` prefix (esbuild keeps them external). */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** The part of esbuild's metafile this test reads. */
interface Metafile {
  readonly outputs: Readonly<
    Record<string, { readonly imports: readonly { path: string; external?: boolean }[] }>
  >;
}

/** One built handler: what esbuild left for the runtime to load (Node builtins aside). */
interface Bundle {
  readonly externals: readonly string[];
}

/**
 * Synthesize with real bundling and read every `NodejsFunction`'s metafile, keyed by the
 * function's logical id. The other tests skip bundling (see vitest.config.ts); post-CLI context
 * overrides that, and asks for the asset paths the CLI would get.
 */
function synthBundles(): Map<string, Bundle> {
  const app = new App({
    postCliContext: {
      'aws:cdk:bundling-stacks': ['**'],
      'aws:cdk:enable-asset-metadata': true,
    },
  });
  const stack = new FreeMailStack(app, 'TestStack', { config });
  const assembly = app.synth();
  const resources = (
    assembly.getStackByName(stack.stackName).template as {
      Resources: Record<string, { Metadata?: Record<string, string> }>;
    }
  ).Resources;
  const bundles = new Map<string, Bundle>();
  // Every NodejsFunction in the stack — not a list of names, so a new one can't slip past.
  for (const fn of stack.node.findAll().filter((c) => c instanceof NodejsFunction)) {
    const logicalId = Stack.of(fn).getLogicalId(fn.node.defaultChild as CfnFunction);
    const assetPath = resources[logicalId]?.Metadata?.['aws:asset:path'] ?? '';
    const metafile = JSON.parse(
      readFileSync(join(assembly.directory, assetPath, 'index.meta.json'), 'utf8'),
    ) as Metafile;
    const externals = Object.values(metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((imported) => imported.external === true && !imported.path.startsWith('node:'))
      .map((imported) => imported.path);
    bundles.set(logicalId, { externals: [...new Set(externals)] });
  }
  return bundles;
}

describe('Lambda bundles', () => {
  let bundles = new Map<string, Bundle>();

  beforeAll(() => {
    bundles = synthBundles();
  });

  it('builds every FreeMail handler', () => {
    expect(
      [...bundles.keys()].map((logicalId) => logicalId.replace(/[0-9A-F]{8}$/, '')).sort(),
    ).toEqual(['ApiAuthorizerHandler', 'ApiMcpHandler', 'ApiRestHandler', 'SesInboundParserFn']);
  });

  it('bundles the AWS SDK (and everything else) instead of loading the Lambda runtime’s copy', () => {
    for (const [logicalId, bundle] of bundles) {
      // Node's own modules aside, esbuild left nothing for the runtime to resolve.
      expect(
        bundle.externals.filter((path) => !NODE_BUILTINS.has(path)),
        logicalId,
      ).toEqual([]);
    }
  });
});
