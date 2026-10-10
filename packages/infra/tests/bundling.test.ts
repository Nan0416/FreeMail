import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
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

const OPTIONAL_SDK_SIGNERS: ReadonlySet<string> = new Set([
  '@aws-sdk/signature-v4-crt',
  '@aws-sdk/signature-v4a',
]);

/** Every FreeMail handler bundle: its function's logical id → its built `index.js`. */
function synthBundles(): Map<string, string> {
  // The other tests skip bundling (see vitest.config.ts); this one builds for real (post-CLI
  // context overrides the environment's), and asks for the asset paths the CLI would get.
  const app = new App({
    postCliContext: {
      'aws:cdk:bundling-stacks': ['**'],
      'aws:cdk:enable-asset-metadata': true,
    },
  });
  const stack = new FreeMailStack(app, 'TestStack', { config });
  const assembly = app.synth();
  const template = assembly.getStackByName(stack.stackName).template as {
    Resources: Record<string, { Type: string; Metadata?: Record<string, string> }>;
  };
  const bundles = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const assetPath = resource.Metadata?.['aws:asset:path'];
    if (resource.Type === 'AWS::Lambda::Function' && assetPath !== undefined) {
      try {
        bundles.set(
          logicalId,
          readFileSync(join(assembly.directory, assetPath, 'index.js'), 'utf8'),
        );
      } catch {
        // Not a NodejsFunction bundle (CDK's own helper Lambdas ship prebuilt directories).
      }
    }
  }
  return bundles;
}

describe('Lambda bundles', () => {
  const bundles = synthBundles();
  const freeMail = [...bundles].filter(([logicalId]) =>
    /^(ApiRestHandler|ApiMcpHandler|ApiAuthorizerHandler|SesInboundParserFn)/.test(logicalId),
  );

  it('builds every FreeMail handler', () => {
    expect(freeMail.map(([logicalId]) => logicalId.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual([
      'ApiAuthorizerHandler',
      'ApiMcpHandler',
      'ApiRestHandler',
      'SesInboundParserFn',
    ]);
  });

  it('bundles the AWS SDK instead of loading the Lambda runtime’s copy', () => {
    for (const [logicalId, code] of freeMail) {
      const external = [...code.matchAll(/require\(["'](@aws-sdk\/[^"']+)["']\)/g)].map(
        (match) => match[1],
      );
      // Only the SDK's OPTIONAL SigV4a / CRT signers stay runtime lookups: it requires them
      // lazily, in a try/catch, just for multi-region access points — which FreeMail never uses.
      expect(
        [...new Set(external)].filter((name) => !OPTIONAL_SDK_SIGNERS.has(name ?? '')),
        logicalId,
      ).toEqual([]);
    }
    const rest = freeMail.find(([logicalId]) => logicalId.startsWith('ApiRestHandler'));
    // The S3 client's code is in the bundle itself.
    expect(rest?.[1]).toContain('S3Client');
  });
});
