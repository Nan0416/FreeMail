import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
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
  /** Inbound raw MIME, parsed attachments, and outbound large attachments. */
  readonly mailBucket: Bucket;
  /** Static hosting origin for the React SPA (served via CloudFront in the web slice). */
  readonly webBucket: Bucket;

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

    this.downloadTokensTable = new Table(this, 'DownloadTokensTable', {
      partitionKey: { name: 'token', type: STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.mailBucket = this.privateBucket('MailBucket');
    this.webBucket = this.privateBucket('WebBucket');
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
