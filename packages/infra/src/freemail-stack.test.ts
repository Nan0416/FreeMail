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
    // The warning must surface the second footgun: taking over the region's single
    // active SES receipt rule set, not just the MX record.
    annotations.hasWarning('*', Match.stringLikeRegexp('active SES receipt'));
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
