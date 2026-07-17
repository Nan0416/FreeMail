import { App, Stack, aws_route53 as route53 } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SesConstruct } from './ses.js';

function synth(emailDomain = 'mail.example.com', zoneName = 'example.com'): Template {
  const stack = new Stack(new App(), 'TestStack', {
    env: { region: 'us-east-1', account: '111111111111' },
  });
  const hostedZone = new route53.HostedZone(stack, 'Zone', { zoneName });
  new SesConstruct(stack, 'Ses', { hostedZone, emailDomain, region: 'us-east-1' });
  return Template.fromStack(stack);
}

describe('SesConstruct', () => {
  it('creates a domain identity with DKIM signing, a custom MAIL FROM, and no email forwarding', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.example.com',
      MailFromAttributes: { MailFromDomain: 'bounce.mail.example.com' },
      FeedbackAttributes: { EmailForwardingEnabled: false },
      ConfigurationSetAttributes: Match.objectLike({
        ConfigurationSetName: Match.anyValue(),
      }),
    });
  });

  it('enables reputation metrics and the bounce+complaint suppression list', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      ReputationOptions: { ReputationMetricsEnabled: true },
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
  });

  it('publishes bounce and complaint events to an SNS topic', () => {
    const template = synth();
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: Match.objectLike({
        Enabled: true,
        MatchingEventTypes: Match.arrayWith(['bounce', 'complaint']),
        SnsDestination: { TopicARN: Match.anyValue() },
      }),
    });
  });

  it('writes all deliverability records to Route53 (3 DKIM + SPF + MAIL FROM MX/SPF + DMARC)', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::RecordSet', 7);

    // SPF for the From domain.
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'mail.example.com',
      Type: 'TXT',
      ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
    });
    // Custom MAIL FROM MX → the region's feedback SMTP endpoint.
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'bounce.mail.example.com',
      Type: 'MX',
      ResourceRecords: ['10 feedback-smtp.us-east-1.amazonses.com'],
    });
    // MAIL FROM SPF.
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'bounce.mail.example.com',
      Type: 'TXT',
      ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
    });
    // DMARC in monitoring mode.
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: '_dmarc.mail.example.com',
      Type: 'TXT',
      ResourceRecords: [Match.stringLikeRegexp('^"v=DMARC1;')],
    });
  });

  it('emits the 3 DKIM CNAMEs using the raw token host verbatim (no L2 zone double-suffix)', () => {
    const template = synth();
    const cnames = Object.values(template.findResources('AWS::Route53::RecordSet')).filter(
      (record) => record.Properties?.Type === 'CNAME',
    );
    expect(cnames).toHaveLength(3);
    for (const cname of cnames) {
      // The DKIM host name is SES's already-fully-qualified token used verbatim
      // (Fn::GetAtt) — NOT the L2 CnameRecord's zone-appended Fn::Join, which would
      // double-suffix the host and break DKIM verification.
      expect(cname.Properties.Name).toHaveProperty('Fn::GetAtt');
      expect(cname.Properties.Name).not.toHaveProperty('Fn::Join');
    }
  });

  it('scopes records to the provided hosted zone', () => {
    const template = synth();
    for (const record of Object.values(template.findResources('AWS::Route53::RecordSet'))) {
      expect(record.Properties.HostedZoneId).toBeDefined();
    }
  });
});
