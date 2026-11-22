import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { FORWARDER_MAX_RECEIVES, ForwardingConstruct } from '../../src/constructs/forwarding.js';

function synth(): Template {
  const stack = new Stack(new App(), 'TestStack', {
    env: { region: 'us-east-1', account: '111111111111' },
  });
  new ForwardingConstruct(stack, 'Forwarding', {
    emailDomain: 'mail.example.com',
    mailBucket: new Bucket(stack, 'MailBucket'),
    emailsTable: new Table(stack, 'EmailsTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
    }),
    forwardingRulesTable: new Table(stack, 'ForwardingRulesTable', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
    }),
    emailReceivedTopic: new Topic(stack, 'EmailReceivedTopic'),
    configurationSetName: 'cfg-test',
  });
  return Template.fromStack(stack);
}

function queueId(template: Template, name: string): string {
  const ids = Object.keys(template.findResources('AWS::SQS::Queue')).filter((id) => id.startsWith(`Forwarding${name}`));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

function forwarderPolicyStatements(template: Template): Record<string, unknown>[] {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  expect(policies).toHaveLength(1);
  return policies[0]!.Properties.PolicyDocument.Statement as Record<string, unknown>[];
}

describe('ForwardingConstruct', () => {
  it('runs the forwarding handler with its environment contract', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Description: 'FreeMail forwarder (received email → forwarding rules → SES re-send).',
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: {
          EMAILS_TABLE: Match.anyValue(),
          FORWARDING_RULES_TABLE: Match.anyValue(),
          MAIL_BUCKET: Match.anyValue(),
          EMAIL_DOMAIN: 'mail.example.com',
          SES_CONFIGURATION_SET: 'cfg-test',
        },
      },
    });
  });

  it('queues the email-received topic raw, with spam filtered out by the subscription', () => {
    const template = synth();
    const topicId = Object.keys(template.findResources('AWS::SNS::Topic'))[0]!;
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      TopicArn: { Ref: topicId },
      Endpoint: { 'Fn::GetAtt': [queueId(template, 'ForwarderQueue'), 'Arn'] },
      RawMessageDelivery: true,
      FilterPolicy: { spam: ['false'] },
    });
    // The topic may send to the queue (the subscription alone isn't enough).
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Principal: { Service: 'sns.amazonaws.com' },
            Condition: { ArnEquals: { 'aws:SourceArn': { Ref: topicId } } },
          }),
        ]),
      },
    });
  });

  it('runs one notification per invocation, at most two at once, reporting failures per record', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: { 'Fn::GetAtt': [queueId(template, 'ForwarderQueue'), 'Arn'] },
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    // The queue, not Lambda's async retries, does the retrying.
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
  });

  it('retries for about half an hour, then dead-letters for 14 days', () => {
    const template = synth();
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 60 });
    template.hasResourceProperties('AWS::SQS::Queue', {
      // Six times the function's timeout.
      VisibilityTimeout: 360,
      MessageRetentionPeriod: 14 * 24 * 3600,
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [queueId(template, 'ForwarderDlq'), 'Arn'] },
        maxReceiveCount: FORWARDER_MAX_RECEIVES,
      },
    });
    expect(FORWARDER_MAX_RECEIVES).toBe(5);
    const dlq = template.findResources('AWS::SQS::Queue')[queueId(template, 'ForwarderDlq')]!;
    expect(dlq.Properties.MessageRetentionPeriod).toBe(14 * 24 * 3600);
  });

  it('may get and update only received rows, update only `forward`, and only list the rules', () => {
    const template = synth();
    const statements = forwarderPolicyStatements(template);
    const dynamo = statements.filter((statement) => JSON.stringify(statement.Action).includes('dynamodb:'));
    expect(dynamo).toHaveLength(3);
    const tableIds = Object.keys(template.findResources('AWS::DynamoDB::Table'));
    const onTable = (prefix: string) => dynamo.filter((statement) => JSON.stringify(statement.Resource).includes(tableIds.find((id) => id.startsWith(prefix))!));
    const emails = onTable('EmailsTable');
    const get = emails.find((statement) => statement.Action === 'dynamodb:GetItem');
    const update = emails.find((statement) => statement.Action === 'dynamodb:UpdateItem');
    expect(emails).toHaveLength(2);
    expect(get?.Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['INBOUND'] }, Null: { 'dynamodb:LeadingKeys': 'false' } });
    expect(update?.Condition).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['INBOUND'], 'dynamodb:Attributes': ['pk', 'sk', 'forward'] },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    });
    expect(onTable('ForwardingRulesTable').map((statement) => statement.Action)).toEqual(['dynamodb:Scan']);
  });

  it('may read only raw inbound MIME from the mail bucket, and write nothing there', () => {
    const statements = forwarderPolicyStatements(synth());
    const s3 = statements.filter((statement) => JSON.stringify(statement.Action).includes('s3:'));
    expect(s3).toHaveLength(1);
    const actions = s3[0]!.Action as string[];
    expect(actions.some((action) => /Put|Delete/.test(action))).toBe(false);
    expect(JSON.stringify(s3[0]!.Resource)).toContain('/inbound/*');
  });

  it('may send through SES on both the identity and the configuration set, only From the forwarding address', () => {
    const statements = forwarderPolicyStatements(synth());
    const ses = statements.find((statement) => JSON.stringify(statement.Action).includes('ses:SendRawEmail'));
    expect(ses?.Action).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
    expect(ses?.Condition).toEqual({ StringEquals: { 'ses:FromAddress': 'forwarding@mail.example.com' } });
    const resources = JSON.stringify(ses?.Resource);
    expect(resources).toContain(':identity/mail.example.com');
    expect(resources).toContain(':configuration-set/cfg-test');
  });

  it('may consume its own queue, and send to no queue', () => {
    const statements = forwarderPolicyStatements(synth());
    const sqs = statements.filter((statement) => JSON.stringify(statement.Action).includes('sqs:'));
    expect(sqs).toHaveLength(1);
    const actions = sqs[0]!.Action as string[];
    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:DeleteMessage');
    expect(actions).not.toContain('sqs:SendMessage');
  });
});
