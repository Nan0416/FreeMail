import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared';
import { FreeMailStack } from '../../src/freemail-stack.js';
import {
  APP_CONTENT_SECURITY_POLICY,
  rewriteApiPath,
  rewriteSpaPath,
  webRuntimeConfigJson,
} from '../../src/constructs/web.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

function synth(overrides: Partial<FreeMailConfig> = {}): Template {
  return Template.fromStack(
    new FreeMailStack(new App(), 'TestStack', { config: { ...config, ...overrides } }),
  );
}

describe('WebConstruct', () => {
  it('serves the SPA from one CloudFront distribution', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { DefaultRootObject: 'index.html' },
    });
  });

  it('routes SPA client paths via a CloudFront Function, NOT distribution-wide error responses', () => {
    const template = synth();
    // Two functions: SPA routing (default behavior) + /api prefix strip (proxy behavior).
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    // The default (S3) behavior serves index.html via a viewer-request function.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          FunctionAssociations: Match.arrayWith([
            Match.objectLike({ EventType: 'viewer-request' }),
          ]),
        },
        // Custom error responses would be distribution-wide and mask real API 403/404s
        // coming back through the /api proxy — they must be gone.
        CustomErrorResponses: Match.absent(),
      },
    });
  });

  it('fronts the private bucket with Origin Access Control (no public bucket)', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'cloudfront.amazonaws.com' } }),
        ]),
      },
    });
  });

  it('owns a private, disposable SPA bucket (block-all, DESTROY + auto-emptied)', () => {
    const template = synth();
    // The web bucket is the disposable one — the mail bucket is RETAIN.
    const webBuckets = Object.values(template.findResources('AWS::S3::Bucket')).filter(
      (b) => b.DeletionPolicy === 'Delete',
    );
    expect(webBuckets).toHaveLength(1);
    expect(webBuckets[0].Properties?.PublicAccessBlockConfiguration).toMatchObject({
      BlockPublicAcls: true,
      RestrictPublicBuckets: true,
    });
    // Auto-emptied on delete so a `cdk destroy` removes the redeployable SPA cleanly.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('proxies /api/* same-origin to the HTTPS API: no caching, all methods, prefix stripped', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
            // ALLOW_ALL includes the write methods the API needs.
            AllowedMethods: Match.arrayWith(['POST', 'DELETE']),
            // Managed CACHING_DISABLED + an origin-request policy (forward cookies/headers).
            CachePolicyId: Match.anyValue(),
            OriginRequestPolicyId: Match.anyValue(),
            // /api is stripped by a viewer-request function before origin routing.
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
            ]),
          }),
        ]),
      },
    });
    // The proxy origin is a custom HTTPS-only origin (the HTTP API), not S3.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: Match.arrayWith([
          Match.objectLike({
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only' }),
          }),
        ]),
      },
    });
  });

  it('deploys the SPA in two cache tiers: immutable assets + no-cache root/config', () => {
    const template = synth();
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
    const invalidating = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    ).filter((resource) => resource.Properties.DistributionId !== undefined);
    expect(invalidating).toHaveLength(1);
    expect(invalidating[0].Properties.DistributionPaths).toEqual(
      expect.arrayContaining(['/index.html', '/config.json']),
    );
  });

  it('applies a strict app CSP + security headers via a ResponseHeadersPolicy on the SPA behavior', () => {
    const template = synth();
    // The policy carries the strict CSP incl. frame-ancestors 'none' (a <meta> cannot).
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
            Override: true,
          },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
        },
      },
    });
    // It is attached to the SPA (default) behavior — NOT the /api proxy behavior.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { DefaultCacheBehavior: { ResponseHeadersPolicyId: Match.anyValue() } },
    });
  });

  it('outputs the web app URL', () => {
    synth().hasOutput('WebAppUrl', {});
  });
});

describe('WebConstruct custom domain (appDomain)', () => {
  it('uses the generated CloudFront domain by default — no cert, no aliases', () => {
    const template = synth();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: Match.absent() },
    });
  });

  it('aliases the distribution to the app domain with a DNS-validated cert + A/AAAA records', () => {
    const template = synth({ appDomain: 'mail.example.com' });
    // DNS-validated ACM cert (in-region us-east-1, which CloudFront requires).
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'mail.example.com',
      ValidationMethod: 'DNS',
    });
    // The distribution carries the alias + the cert.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['mail.example.com'],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: Match.anyValue() }),
      },
    });
    // Both an A (IPv4) and AAAA (IPv6) alias record point at the distribution.
    const aliasRecords = Object.values(template.findResources('AWS::Route53::RecordSet')).filter(
      (r) =>
        r.Properties?.Name === 'mail.example.com.' &&
        (r.Properties?.Type === 'A' || r.Properties?.Type === 'AAAA'),
    );
    expect(aliasRecords).toHaveLength(2);
    expect(aliasRecords.every((r) => r.Properties?.AliasTarget !== undefined)).toBe(true);
  });

  it('keeps the SPA same-origin (#31): the deployed config.json still points at relative /api', () => {
    // A custom domain must NOT turn the SPA cross-origin — the app still calls the
    // same-origin /api proxy, so the __Host- / SameSite=Strict cookie auth is unaffected.
    expect(webRuntimeConfigJson(false)).toEqual({ apiBaseUrl: '/api', inboundEnabled: false });
    // And the /api proxy behavior survives unchanged alongside a custom domain.
    const template = synth({ appDomain: 'mail.example.com' });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]),
      },
    });
  });
});

describe('webRuntimeConfigJson (deployed config.json content)', () => {
  it('points the SPA at the same-origin /api proxy and carries the inbound flag', () => {
    expect(webRuntimeConfigJson(false)).toEqual({ apiBaseUrl: '/api', inboundEnabled: false });
    expect(webRuntimeConfigJson(true)).toEqual({ apiBaseUrl: '/api', inboundEnabled: true });
  });
});

describe('APP_CONTENT_SECURITY_POLICY', () => {
  it('is a strict deny-by-default policy that still permits the reader srcdoc frame', () => {
    expect(APP_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    // The reader iframe is a same-URL srcdoc → 'self'; the email doc is independently
    // locked by its own injected <meta> CSP.
    expect(APP_CONTENT_SECURITY_POLICY).toContain("frame-src 'self'");
    // No wildcard sources anywhere.
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain('*');
  });
});

describe('rewriteApiPath (proxy prefix strip — boundary)', () => {
  it('strips exactly the /api prefix for real API routes', () => {
    expect(rewriteApiPath('/api/auth/login')).toBe('/auth/login');
    expect(rewriteApiPath('/api/emails/abc/attachments/0')).toBe('/emails/abc/attachments/0');
    expect(rewriteApiPath('/api/')).toBe('/');
    expect(rewriteApiPath('/api')).toBe('/');
  });

  it('does NOT match a lookalike prefix like /apiary', () => {
    expect(rewriteApiPath('/apiary')).toBe('/apiary');
    expect(rewriteApiPath('/apiary/keys')).toBe('/apiary/keys');
  });
});

describe('rewriteSpaPath (client-route fallback)', () => {
  it('serves index.html for extensionless client routes', () => {
    expect(rewriteSpaPath('/')).toBe('/index.html');
    expect(rewriteSpaPath('/inbox')).toBe('/index.html');
    expect(rewriteSpaPath('/keys/new')).toBe('/index.html');
  });

  it('leaves real files (with an extension) untouched', () => {
    expect(rewriteSpaPath('/assets/app-abc123.js')).toBe('/assets/app-abc123.js');
    expect(rewriteSpaPath('/config.json')).toBe('/config.json');
    expect(rewriteSpaPath('/index.html')).toBe('/index.html');
  });
});
