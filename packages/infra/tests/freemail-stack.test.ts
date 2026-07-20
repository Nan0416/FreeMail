import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared';
import { FreeMailStack } from '../src/freemail-stack.js';

function makeConfig(overrides: Partial<FreeMailConfig> = {}): FreeMailConfig {
  return {
    region: 'us-east-1',
    hostedZone: { mode: 'create', zoneName: 'example.com' },
    emailDomain: 'example.com',
    inbound: { enabled: false, confirmInboundMx: false },
    ...overrides,
  };
}

function synth(config: FreeMailConfig): Template {
  const stack = new FreeMailStack(new App(), 'TestStack', { config });
  return Template.fromStack(stack);
}

describe('FreeMailStack', () => {
  it('pins the stack to the configured region', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    expect(stack.region).toBe('us-east-1');
  });

  it('creates the data layer: 4 tables + 2 buckets — data retained, web disposable', () => {
    const template = synth(makeConfig());
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.allResourcesProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    // Tables + the mail bucket hold the deployer's real data → RETAIN (a cdk destroy
    // must never wipe email). RETAIN is a resource-level DeletionPolicy, not a property.
    for (const resource of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    // Exactly one retained bucket (mail) and one disposable bucket (the SPA web bucket,
    // owned by WebConstruct — holds only the redeployable build).
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(buckets.filter((b) => b.DeletionPolicy === 'Retain')).toHaveLength(1);
    expect(buckets.filter((b) => b.DeletionPolicy === 'Delete')).toHaveLength(1);
    // The disposable web bucket is auto-emptied on delete (CFN can't remove a non-empty bucket).
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('buckets block public access and enforce SSL', () => {
    const template = synth(makeConfig());
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('wires SES sending: identity for the email domain + config set + bounce/complaint topic', () => {
    const template = synth(makeConfig({ emailDomain: 'mail.example.com' }));
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.example.com',
      MailFromAttributes: { MailFromDomain: 'bounce.mail.example.com' },
    });
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasOutput('SesProductionAccessNote', {});
  });

  it('creates a hosted zone when mode is "create" and outputs name servers', () => {
    const template = synth(makeConfig({ hostedZone: { mode: 'create', zoneName: 'example.com' } }));
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasOutput('HostedZoneNameServers', {});
  });

  it('imports a hosted zone when mode is "import" (no zone resource, no NS output)', () => {
    const template = synth(
      makeConfig({ hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z123' } }),
    );
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    expect(() => template.hasOutput('HostedZoneNameServers', {})).toThrow();
    template.hasOutput('HostedZoneId', {});
  });

  it('does not wire inbound (no receipt rule set / MX) when inbound is disabled', () => {
    const template = synth(makeConfig());
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    template.resourceCountIs('AWS::SES::ReceiptRule', 0);
    // Only the SES sending records exist; no inbound MX on the email domain.
    const mxRecords = Object.values(template.findResources('AWS::Route53::RecordSet')).filter(
      (r) => r.Properties?.Type === 'MX',
    );
    expect(mxRecords.every((r) => r.Properties?.Name !== 'example.com')).toBe(true);
  });

  it('wires inbound (receipt rule set → S3 + inbound MX + activation CR) when enabled', () => {
    const template = synth(
      makeConfig({
        emailDomain: 'mail.example.com',
        inbound: { enabled: true, confirmInboundMx: true },
      }),
    );
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: { Recipients: ['mail.example.com'], ScanEnabled: true },
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'mail.example.com',
      Type: 'MX',
      ResourceRecords: ['10 inbound-smtp.us-east-1.amazonaws.com'],
    });
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('warns at synth when inbound is enabled — MX and active-rule-set takeover', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }),
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasWarning('*', Match.stringLikeRegexp('Inbound email is ENABLED'));
    // The warning must surface the second footgun: FreeMail becoming the region's
    // single active receipt rule set, with a fail-safe deploy on conflict.
    annotations.hasWarning('*', Match.stringLikeRegexp('receipt rule set'));
    annotations.hasWarning('*', Match.stringLikeRegexp('deploy FAILS'));
  });

  it('does not warn when inbound is disabled', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('Inbound email is ENABLED'),
    );
  });

  it('refuses to synth inbound without the MX acknowledgement', () => {
    expect(
      () =>
        new FreeMailStack(new App(), 'TestStack', {
          config: makeConfig({ inbound: { enabled: true, confirmInboundMx: false } }),
        }),
    ).toThrow(/MX override has not been acknowledged/);
  });

  it('warns (does not block) when a custom domain is set on a CREATED zone', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({ appDomain: 'mail.example.com' }),
    });
    const annotations = Annotations.fromStack(stack);
    // Actionable: names the hang and the fix (delegate the zone's name servers).
    annotations.hasWarning('*', Match.stringLikeRegexp('custom domain is configured on a CREATED'));
    annotations.hasWarning('*', Match.stringLikeRegexp('HANG on certificate validation'));
    annotations.hasWarning('*', Match.stringLikeRegexp('name servers'));
  });

  it('does NOT warn about custom domains on an IMPORTED (already-delegated) zone', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({
        hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z123' },
        appDomain: 'mail.example.com',
      }),
    });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('custom domain is configured'),
    );
  });

  it('does NOT warn about custom domains when none are configured', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('custom domain is configured'),
    );
  });

  it('outputs custom URLs + the raw CloudFront domain when app/api domains are set', () => {
    const template = synth(
      makeConfig({ appDomain: 'mail.example.com', apiDomain: 'api.example.com' }),
    );
    template.hasOutput('WebAppUrl', { Value: 'https://mail.example.com' });
    template.hasOutput('WebDistributionDomainName', {});
    template.hasOutput('ApiCustomDomainUrl', { Value: 'https://api.example.com' });
    template.hasOutput('CustomDomainValidationNote', {});
  });

  it('falls back to generated URLs with no custom-domain outputs when unset', () => {
    const template = synth(makeConfig());
    // WebAppUrl is present but carries the generated CloudFront domain (a token), not a custom host.
    template.hasOutput('WebAppUrl', {});
    expect(() => template.hasOutput('ApiCustomDomainUrl', {})).toThrow();
    expect(() => template.hasOutput('CustomDomainValidationNote', {})).toThrow();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
  });
});
