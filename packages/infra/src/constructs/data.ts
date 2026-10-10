import {
  EMAIL_LIST_INDEX_ATTRIBUTES,
  EMAIL_LIST_INDEX_NAME,
  INBOUND_INGESTED_TAG,
  INBOUND_RAW_RETENTION_DAYS,
} from '@freemail/shared/storage';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
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
export interface DataConstructProps {
  /** The web app's origin (`https://<appDomain>`): the only origin that may PUT uploads. */
  readonly appOrigin: string;
}

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
  /**
   * Raw MIME of received messages whose content could not be extracted (the Errors folder):
   * SES's `inbound/` copy expires, so these are copied here to stay downloadable. No expiry.
   */
  readonly quarantineBucket: Bucket;

  constructor(scope: Construct, id: string, props: DataConstructProps) {
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
    this.quarantineBucket = this.privateBucket('QuarantineBucket');
    // Attachment uploads go straight from the browser to S3 with a presigned PUT, so the
    // bucket must answer that origin's CORS preflight — for PUT only, and only from the app.
    this.mailBucket.addCorsRule({
      allowedMethods: [HttpMethods.PUT],
      allowedOrigins: [props.appOrigin],
      allowedHeaders: ['content-type'],
      exposedHeaders: ['etag'],
      maxAge: 3000,
    });
    // An upload is copied to its permanent key when it is sent; one never sent is swept.
    this.mailBucket.addLifecycleRule({
      id: 'ExpireUnsentUploads',
      prefix: 'uploads/',
      expiration: Duration.days(1),
      abortIncompleteMultipartUploadAfter: Duration.days(1),
    });
    // SES's raw inbound MIME becomes staging once ingest has stored what the message needs (its
    // body + attachments, or — for a failed message — a copy in the quarantine bucket): the
    // parser then tags it, and only then does it expire — it backs just the short-lived
    // "Download original". Untagged raw MIME (a message whose ingest dead-lettered, anything
    // from before tagging) is the only copy and is kept.
    // Scoped to `inbound/` ONLY — stored bodies, attachments, and the sent archive are
    // permanent, and sent-mail attachment downloads point at `attachments/sent/*`.
    this.mailBucket.addLifecycleRule({
      id: 'ExpireIngestedInboundRawMime',
      prefix: 'inbound/',
      tagFilters: { [INBOUND_INGESTED_TAG.key]: INBOUND_INGESTED_TAG.value },
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
