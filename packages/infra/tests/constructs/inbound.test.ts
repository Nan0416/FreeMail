import {
  App,
  Stack,
  aws_dynamodb as dynamodb,
  aws_route53 as route53,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { InboundConstruct } from '../../src/constructs/inbound.js';

function emailsTable(stack: Stack): dynamodb.Table {
  return new dynamodb.Table(stack, 'EmailsTable', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
}

function synth(emailDomain = 'mail.example.com', zoneName = 'example.com'): Template {
  const stack = new Stack(new App(), 'TestStack', {
    env: { region: 'us-east-1', account: '111111111111' },
  });
  const hostedZone = new route53.HostedZone(stack, 'Zone', { zoneName });
  const mailBucket = new s3.Bucket(stack, 'MailBucket');
  new InboundConstruct(stack, 'Inbound', {
    hostedZone,
    emailDomain,
    region: 'us-east-1',
    mailBucket,
    emailsTable: emailsTable(stack),
  });
  return Template.fromStack(stack);
}

describe('InboundConstruct', () => {
  it('creates a receipt rule set with one catch-all rule scoped to the domain, scanning enabled', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    template.resourceCountIs('AWS::SES::ReceiptRule', 1);
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: {
        Enabled: true,
        // Domain-scoped, not empty: matches every local part @mail.example.com,
        // but not mail for other domains sharing the region's active rule set.
        Recipients: ['mail.example.com'],
        ScanEnabled: true,
      },
    });
  });

  it('delivers raw MIME to the mail bucket under the inbound/ prefix', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: {
        Actions: [
          {
            S3Action: {
              BucketName: Match.anyValue(),
              ObjectKeyPrefix: 'inbound/',
            },
          },
        ],
      },
    });
  });

  it('grants SES permission to write objects to the mail bucket', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:PutObject',
            Effect: 'Allow',
            Principal: { Service: 'ses.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('points the inbound domain MX at the region SES inbound SMTP endpoint', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'mail.example.com',
      Type: 'MX',
      ResourceRecords: ['10 inbound-smtp.us-east-1.amazonaws.com'],
    });
  });

  it('auto-activates the rule set via a custom resource with least-privilege SES activation perms', () => {
    const template = synth();
    // A CloudFormation custom resource drives ses:SetActiveReceiptRuleSet (CFN has no
    // native way to set the region's active rule set).
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ses:DescribeActiveReceiptRuleSet',
              'ses:SetActiveReceiptRuleSet',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('exposes the receipt rule set name for the stack to activate/output', () => {
    const stack = new Stack(new App(), 'TestStack', {
      env: { region: 'us-east-1', account: '111111111111' },
    });
    const hostedZone = new route53.HostedZone(stack, 'Zone', { zoneName: 'example.com' });
    const mailBucket = new s3.Bucket(stack, 'MailBucket');
    const inbound = new InboundConstruct(stack, 'Inbound', {
      hostedZone,
      emailDomain: 'mail.example.com',
      region: 'us-east-1',
      mailBucket,
      emailsTable: emailsTable(stack),
    });
    expect(inbound.ruleSet.receiptRuleSetName).toBeTruthy();
  });

  describe('parser pipeline', () => {
    it('triggers the parser Lambda on ObjectCreated scoped to the inbound/ prefix', () => {
      const template = synth();
      // S3 → Lambda notifications are wired via the BucketNotifications custom resource.
      template.hasResourceProperties('Custom::S3BucketNotifications', {
        NotificationConfiguration: {
          LambdaFunctionConfigurations: Match.arrayWith([
            Match.objectLike({
              Events: ['s3:ObjectCreated:*'],
              Filter: {
                Key: {
                  FilterRules: Match.arrayWith([{ Name: 'prefix', Value: 'inbound/' }]),
                },
              },
            }),
          ]),
        },
      });
    });

    it('configures async retry + an on-failure SQS DLQ (S3 async invocation, not an SQS source)', () => {
      const template = synth();
      template.resourceCountIs('AWS::SQS::Queue', 1);
      template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
        MaximumRetryAttempts: 2,
        DestinationConfig: {
          OnFailure: { Destination: Match.anyValue() },
        },
      });
    });

    it('grants the parser read + write + delete on the mail bucket (raw read, attachment write, cleanup)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:GetObject*', 's3:DeleteObject*', 's3:PutObject']),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('grants the parser write (PutItem) on the emails table', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:PutItem']),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });
});
