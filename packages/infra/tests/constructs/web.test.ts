import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared/config';
import { FreeMailStack } from '../../src/freemail-stack.js';
import { appContentSecurityPolicy, webRuntimeConfigJson } from '../../src/constructs/web.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  sesIdentity: { mode: 'create' },
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

  it('routes SPA client paths via distribution-wide error responses, with NO CloudFront Functions', () => {
    const template = synth();
    // Both Functions are gone with the proxy (#47): SPA routing and the /api prefix strip.
    template.resourceCountIs('AWS::CloudFront::Function', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({ FunctionAssociations: Match.absent() }),
        // Safe again now that only S3 is behind this distribution — there is no API
        // whose real 403/404 responses a distribution-wide rule could mask.
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

  it('is SPA-ONLY: no /api behavior and no non-S3 origin (#47)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        // The `/api/*` proxy behavior is gone entirely — the browser now reaches the
        // API cross-origin at the api domain under a locked CORS policy.
        CacheBehaviors: Match.absent(),
      },
    });
    // Exactly one origin, and it is S3 (OAC) — no custom HTTP origin remains.
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    const origins = distribution?.Properties?.DistributionConfig?.Origins as Record<
      string,
      unknown
    >[];
    expect(origins).toHaveLength(1);
    expect(origins[0]?.CustomOriginConfig).toBeUndefined();
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
  it('always aliases the distribution — there is no generated-CloudFront-domain fallback (#47)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { Aliases: ['app.example.com'] },
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

  it('permits the cross-origin API in the deployed CSP (#47, supersedes #31)', () => {
    // The SPA is now cross-origin with the API, so the app CSP must name the api origin
    // in connect-src or every call is blocked before CORS is even consulted. (config.json
    // itself is bundled into an S3 asset, so its content is asserted directly against
    // `webRuntimeConfigJson` below — the repo's deployed-===-tested pattern.)
    synth().hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "connect-src 'self' https://api\\.example\\.com",
            ),
          },
        },
      },
    });
  });
});

describe('webRuntimeConfigJson (deployed config.json content)', () => {
  it('carries the absolute api origin and the inbound flag', () => {
    expect(webRuntimeConfigJson('https://api.example.com', false)).toEqual({
      apiBaseUrl: 'https://api.example.com',
      inboundEnabled: false,
    });
    expect(webRuntimeConfigJson('https://api.example.com', true)).toEqual({
      apiBaseUrl: 'https://api.example.com',
      inboundEnabled: true,
    });
  });

  it('refuses a non-https api base URL', () => {
    // The deployed SPA sends credentialed cross-origin requests; an http origin would
    // both break `__Host-`/Secure cookies and expose the session in transit.
    expect(() => webRuntimeConfigJson('http://api.example.com', false)).toThrow(/https/);
    expect(() => webRuntimeConfigJson('/api', false)).toThrow(/https/);
  });
});

describe('appContentSecurityPolicy', () => {
  const policy = appContentSecurityPolicy('https://api.example.com');

  it('is a strict deny-by-default policy that still permits the reader srcdoc frame', () => {
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // The reader iframe is a same-URL srcdoc → 'self'; the email doc is independently
    // locked by its own injected <meta> CSP.
    expect(policy).toContain("frame-src 'self'");
    // No wildcard sources anywhere.
    expect(policy).not.toContain('*');
  });

  it('names the api origin in connect-src so the cross-origin API calls are permitted', () => {
    // CSP and CORS are independent gates: without this the app CSP would block every
    // API call even though the API's CORS policy allows it.
    expect(policy).toContain("connect-src 'self' https://api.example.com");
  });

  it('adds exactly ONE extra origin, and only to connect-src', () => {
    const api = 'https://api.example.com';
    const directivesNamingApi = policy.split('; ').filter((directive) => directive.includes(api));
    expect(directivesNamingApi).toEqual([`connect-src 'self' ${api}`]);
    // script-src is never widened — the api origin must not become a script source.
    expect(policy).toContain("script-src 'self'");
  });
});
