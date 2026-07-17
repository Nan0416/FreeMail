import { RemovalPolicy, aws_dynamodb as dynamodb, aws_s3 as s3 } from 'aws-cdk-lib';
import { Construct } from 'constructs';

const STRING = dynamodb.AttributeType.STRING;

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
  readonly authTable: dynamodb.Table;
  /** Hashed agent API keys, keyed by public key ID. */
  readonly apiKeysTable: dynamodb.Table;
  /** Email metadata / index (inbound + sent). Populated by the read slice. */
  readonly emailsTable: dynamodb.Table;
  /** Large-attachment download tokens (TTL on `ttl`). */
  readonly downloadTokensTable: dynamodb.Table;
  /** Inbound raw MIME, parsed attachments, and outbound large attachments. */
  readonly mailBucket: s3.Bucket;
  /** Static hosting origin for the React SPA (served via CloudFront in the web slice). */
  readonly webBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.authTable = new dynamodb.Table(this, 'AuthTable', {
      partitionKey: { name: 'pk', type: STRING },
      sortKey: { name: 'sk', type: STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.apiKeysTable = new dynamodb.Table(this, 'ApiKeysTable', {
      partitionKey: { name: 'keyId', type: STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.emailsTable = new dynamodb.Table(this, 'EmailsTable', {
      partitionKey: { name: 'pk', type: STRING },
      sortKey: { name: 'sk', type: STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.downloadTokensTable = new dynamodb.Table(this, 'DownloadTokensTable', {
      partitionKey: { name: 'token', type: STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.mailBucket = this.privateBucket('MailBucket');
    this.webBucket = this.privateBucket('WebBucket');
  }

  private privateBucket(id: string): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
