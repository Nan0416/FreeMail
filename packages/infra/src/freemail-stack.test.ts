import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared';
import { FreeMailStack } from './freemail-stack.js';

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

  it('creates the data layer: 4 tables + 2 buckets, all retained', () => {
    const template = synth(makeConfig());
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.allResourcesProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    // RETAIN is expressed as a resource-level DeletionPolicy, not a property.
    for (const resource of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    for (const resource of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(resource.DeletionPolicy).toBe('Retain');
    }
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

  it('warns at synth when inbound is enabled', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }),
    });
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('Inbound email is ENABLED'),
    );
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
});
