import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { SubscriptionFilter, type ITopic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { FORWARDER_LOCAL_PART } from '@freemail/shared';
import { INBOUND_PARTITION } from '@freemail/shared/storage';
import { SELF_CONTAINED_BUNDLING } from './bundling.js';
import { grantSesSend } from './ses-grants.js';

const HANDLERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'service', 'src', 'handlers');

/** Where SES stores raw inbound MIME — the only objects the forwarder reads. */
const INBOUND_PREFIX = 'inbound/';

const FORWARDER_TIMEOUT = Duration.minutes(1);
/** Receives before a notification is dead-lettered: about half an hour of retries. */
export const FORWARDER_MAX_RECEIVES = 5;

export interface ForwardingConstructProps {
  readonly emailDomain: string;
  readonly mailBucket: IBucket;
  readonly emailsTable: ITable;
  /** The rules, edited through the REST API; the forwarder only reads them. */
  readonly forwardingRulesTable: ITable;
  /** The inbound pipeline's email-received topic; the forwarder is one of its subscribers. */
  readonly emailReceivedTopic: ITopic;
  readonly configurationSetName: string;
}

/**
 * Forwarding: a Lambda that re-sends matching mail to the addresses its rules name, fed by a
 * queue subscribed to the email-received topic. Apart from the parser, so a failed send retries
 * and dead-letters on its own, and the parser never holds permission to send.
 *
 * A queue rather than a direct subscription: a failed forward is retried for about half an hour
 * (an SES throttle or pause outlasts Lambda's two async retries), a dead-lettered one can be
 * redriven from the console, disabling the event source pauses forwarding for up to 14 days,
 * and at most two forwards send at once.
 */
export class ForwardingConstruct extends Construct {
  readonly forwarder: NodejsFunction;
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: ForwardingConstructProps) {
    super(scope, id);

    this.forwarder = new NodejsFunction(this, 'ForwarderFn', {
      entry: join(HANDLERS_DIR, 'forwarding.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // Holds one capped raw message, its rewritten copy, and the SES request encoding it.
      memorySize: 512,
      timeout: FORWARDER_TIMEOUT,
      description: 'FreeMail forwarder (received email → forwarding rules → SES re-send).',
      environment: {
        EMAILS_TABLE: props.emailsTable.tableName,
        FORWARDING_RULES_TABLE: props.forwardingRulesTable.tableName,
        MAIL_BUCKET: props.mailBucket.bucketName,
        EMAIL_DOMAIN: props.emailDomain,
        SES_CONFIGURATION_SET: props.configurationSetName,
      },
      bundling: SELF_CONTAINED_BUNDLING,
      logGroup: new LogGroup(this, 'ForwarderLogs', {
        retention: RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // Reads a received row and records the forward on it — nothing else. Both actions are held to
    // the INBOUND partition (never a sent row, the Errors folder or an idempotency record), and the
    // update to the `forward` attribute (plus the key attributes, which DynamoDB requires listed),
    // returning nothing. It never creates, deletes or queries a row.
    const onlyInbound = { 'dynamodb:LeadingKeys': [INBOUND_PARTITION] };
    this.forwarder.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [props.emailsTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': onlyInbound },
      }),
    );
    this.forwarder.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [props.emailsTable.tableArn],
        conditions: {
          'ForAllValues:StringEquals': { ...onlyInbound, 'dynamodb:Attributes': ['pk', 'sk', 'forward'] },
          StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
        },
      }),
    );
    // Lists the rules; never edits them.
    props.forwardingRulesTable.grant(this.forwarder, 'dynamodb:Scan');
    props.mailBucket.grantRead(this.forwarder, `${INBOUND_PREFIX}*`);
    // Sends only From the forwarding address.
    grantSesSend(this.forwarder, props.emailDomain, props.configurationSetName, { fromAddress: `${FORWARDER_LOCAL_PART}@${props.emailDomain}` });

    // A message keeps its first enqueue time when dead-lettered, so both keep the 14-day maximum.
    this.deadLetterQueue = new Queue(this, 'ForwarderDlq', {
      retentionPeriod: Duration.days(14),
    });
    this.queue = new Queue(this, 'ForwarderQueue', {
      retentionPeriod: Duration.days(14),
      // Six times the function's timeout (AWS's guidance), which also spaces the retries.
      visibilityTimeout: Duration.seconds(FORWARDER_TIMEOUT.toSeconds() * 6),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: FORWARDER_MAX_RECEIVES },
    });
    // Spam is never forwarded, so it never reaches the queue. Raw: each body is the notification.
    props.emailReceivedTopic.addSubscription(
      new SqsSubscription(this.queue, {
        rawMessageDelivery: true,
        filterPolicy: { spam: SubscriptionFilter.stringFilter({ allowlist: ['false'] }) },
      }),
    );
    this.forwarder.addEventSource(
      new SqsEventSource(this.queue, {
        // One notification per invocation: a slow or failing forward never holds up or replays
        // another.
        batchSize: 1,
        reportBatchItemFailures: true,
        // The fewest SQS allows; keeps forwards well inside SES's sending rate.
        maxConcurrency: 2,
      }),
    );
  }
}
