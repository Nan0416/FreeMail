import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared';
import { FreeMailStack } from '../freemail-stack.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

function synth(): Template {
  return Template.fromStack(new FreeMailStack(new App(), 'TestStack', { config }));
}

describe('WebConstruct', () => {
  it('serves the SPA from one CloudFront distribution with an SPA fallback', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    });
  });

  it('fronts the private bucket with Origin Access Control (no public bucket)', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    // The web bucket stays public-access-blocked (asserted in freemail-stack.test);
    // CloudFront reads it via an OAC-scoped bucket policy.
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('deploys the SPA in two cache tiers: immutable assets + no-cache root/config', () => {
    const template = synth();
    // Two BucketDeployments: hashed assets (long-cache) + root files & config.json (no-cache).
    template.resourceCountIs('Custom::CDKBucketDeployment', 2);
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: { 'cache-control': Match.stringLikeRegexp('immutable') },
    });
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: { 'cache-control': Match.stringLikeRegexp('no-cache') },
    });
  });

  it('invalidates index.html + config.json on deploy so a stale endpoint cannot pin', () => {
    const template = synth();
    // Exactly one deployment (the root/config tier) carries a CloudFront invalidation.
    const invalidating = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    ).filter((resource) => resource.Properties.DistributionId !== undefined);
    expect(invalidating).toHaveLength(1);
    expect(invalidating[0].Properties.DistributionPaths).toEqual(
      expect.arrayContaining(['/index.html', '/config.json']),
    );
  });

  it('outputs the web app URL', () => {
    synth().hasOutput('WebAppUrl', {});
  });
});
