import {
  EMAIL_LIST_INDEX_ATTRIBUTES,
  EMAIL_LIST_INDEX_NAME,
  INBOUND_RAW_RETENTION_DAYS,
} from '@freemail/shared/storage';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const STRING = AttributeType.STRING;

/**
 * The persistence layer: DynamoDB tables + S3 buckets that the API, MCP, and
 * inbound-mail slices read and write. Everything here holds the deployer's own
 * mail/auth data, so buckets and tables are RETAINed on stack delete — a
 * `cdk destroy` must never silently wipe a user's email.
 *
 * All tables are on-demand (PAY_PER_REQUEST): a single-tenant deployment has
 * spiky, low traffic, so there's no capacity to provision.
 */
export class DataConstruct extends Construct {
  /** Single-tenant password hash + rotating refresh tokens (TTL on `ttl`). */
  readonly authTable: Table;
  /** Hashed agent API keys, keyed by public key ID. */
  readonly apiKeysTable: Table;
  /** Email metadata / index (inbound + sent). Populated by the read slice. */
  readonly emailsTable: Table;
  /** Large-attachment download tokens (TTL on `ttl`). */
  readonly downloadTokensTable: Table;
  /** Inbound raw MIME (expiring), stored bodies, parsed attachments, sent MIME + attachments. */
  readonly mailBucket: Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.authTable = new Table(this, 'AuthTable', {
      partitionKey: { name: 'pk', type: STRING },
      sortKey: { name: 'sk', type: STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.apiKeysTable = new Table(this, 'ApiKeysTable', {
      partitionKey: { name: 'keyId', type: STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.emailsTable = new Table(this, 'EmailsTable', {
      partitionKey: { name: 'pk', type: STRING },
      sortKey: { name: 'sk', type: STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // The mailbox list reads this index, not the table: same keys, but only the list fields
    // are projected, so a page is sized (and billed) by those fields however large the stored
    // bodies and attachment descriptors get. The attribute list is shared with the service.
    this.emailsTable.addGlobalSecondaryIndex({
      indexName: EMAIL_LIST_INDEX_NAME,
      partitionKey: { name: 'pk', type: STRING },
      sortKey: { name: 'sk', type: STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...EMAIL_LIST_INDEX_ATTRIBUTES],
    });

    this.downloadTokensTable = new Table(this, 'DownloadTokensTable', {
      partitionKey: { name: 'token', type: STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.mailBucket = this.privateBucket('MailBucket');
    // SES's raw inbound MIME is staging: ingest extracts the body and attachments, so the raw
    // object only backs the short-lived "Download original". Scoped to `inbound/` ONLY —
    // stored bodies, attachments, and the sent archive are permanent, and sent-mail
    // attachment downloads point at `attachments/outbound/*`.
    this.mailBucket.addLifecycleRule({
      id: 'ExpireInboundRawMime',
      prefix: 'inbound/',
      expiration: Duration.days(INBOUND_RAW_RETENTION_DAYS),
    });
  }

  private privateBucket(id: string): Bucket {
    return new Bucket(this, id, {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
