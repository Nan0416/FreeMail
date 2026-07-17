import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Duration,
  Stack,
  aws_apigatewayv2 as apigwv2,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

const HANDLERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'service',
  'src',
  'handlers',
);

export interface ApiConstructProps {
  /** Single-tenant password hash + rotating refresh tokens + lockout counters. */
  authTable: dynamodb.Table;
  /** Hashed agent API keys — the REST handler manages them; the authorizer validates presented keys. */
  apiKeysTable: dynamodb.Table;
  /** Sent/inbound email metadata — the send route records sent messages, the read routes list/get them. */
  emailsTable: dynamodb.Table;
  /** Inbound raw MIME + extracted attachments — the read routes re-parse bodies and presign downloads. */
  mailBucket: s3.IBucket;
  /** The SES send domain — `from` must be under it, and it scopes the send IAM grant. */
  emailDomain: string;
  /** SES configuration set the send route routes through (suppression + bounce/complaint tracking). */
  sesConfigurationSetName: string;
}

/**
 * The HTTP API skeleton: one HTTP API fronted by a dual-scheme Lambda authorizer,
 * with the auth routes (public), a protected `GET /me`, and the `/keys`
 * management routes wired to a single REST handler. Later slices plug in through
 * the exposed `httpApi`/`authorizer` and the `addRestRoute` helper — REST slices
 * (#6 send) reuse the same handler; the MCP server (#7) adds its own route +
 * integration behind the same authorizer.
 *
 * API Gateway itself stays unauthenticated (managed CORS answers preflight, auth
 * routes are open); all authentication happens in the backend authorizer.
 */
export class ApiConstruct extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly authorizer: HttpLambdaAuthorizer;
  readonly restHandler: nodejs.NodejsFunction;
  readonly authorizerHandler: nodejs.NodejsFunction;
  /** MCP server (agent-facing `send_email` tool) — its own handler behind the shared authorizer. */
  readonly mcpHandler: nodejs.NodejsFunction;
  /** Auto-generated HS256 signing key (no manual bootstrap step). */
  readonly signingKey: secretsmanager.Secret;
  private readonly restIntegration: HttpLambdaIntegration;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);
    const {
      authTable,
      apiKeysTable,
      emailsTable,
      mailBucket,
      emailDomain,
      sesConfigurationSetName,
    } = props;

    this.signingKey = new secretsmanager.Secret(this, 'JwtSigningKey', {
      description: 'HS256 signing key for FreeMail access tokens.',
      // Generated at deploy → the "one cdk deploy" UX needs no out-of-band secret.
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    this.restHandler = this.nodeFunction('RestHandler', 'rest.ts', {
      description: 'FreeMail REST API (auth + app routes).',
      memorySize: 1024, // more vCPU so the scrypt hash on login stays sub-second
      environment: {
        AUTH_TABLE: authTable.tableName,
        API_KEYS_TABLE: apiKeysTable.tableName,
        EMAILS_TABLE: emailsTable.tableName,
        MAIL_BUCKET: mailBucket.bucketName,
        EMAIL_DOMAIN: emailDomain,
        SES_CONFIGURATION_SET: sesConfigurationSetName,
        SIGNING_KEY_SECRET_ID: this.signingKey.secretName,
      },
    });
    authTable.grantReadWriteData(this.restHandler);
    // The REST handler mints, lists, and revokes keys.
    apiKeysTable.grantReadWriteData(this.restHandler);
    // The send route records sent-email metadata; the read routes list/get it.
    emailsTable.grantReadWriteData(this.restHandler);
    // The read routes re-parse raw inbound MIME (for bodies) and presign attachment
    // downloads — scoped to the inbound raw + extracted-attachment prefixes only.
    mailBucket.grantRead(this.restHandler, 'inbound/*');
    mailBucket.grantRead(this.restHandler, 'attachments/inbound/*');
    this.signingKey.grantRead(this.restHandler);

    // The REST `/emails` route sends.
    this.grantSesSend(this.restHandler, emailDomain);

    // MCP server: its own handler, but reuses the same EmailService, so it needs the
    // same emails-table write + SES send grants. It does NOT touch auth/keys tables
    // or the signing key — authentication is entirely the shared authorizer's job.
    this.mcpHandler = this.nodeFunction('McpHandler', 'mcp.ts', {
      description: 'FreeMail MCP server (send_email tool).',
      memorySize: 512,
      environment: {
        EMAILS_TABLE: emailsTable.tableName,
        EMAIL_DOMAIN: emailDomain,
        SES_CONFIGURATION_SET: sesConfigurationSetName,
      },
    });
    emailsTable.grantWriteData(this.mcpHandler);
    this.grantSesSend(this.mcpHandler, emailDomain);

    this.authorizerHandler = this.nodeFunction('AuthorizerHandler', 'authorizer.ts', {
      description: 'FreeMail Lambda authorizer (access tokens + API keys).',
      environment: {
        API_KEYS_TABLE: apiKeysTable.tableName,
        SIGNING_KEY_SECRET_ID: this.signingKey.secretName,
      },
    });
    this.signingKey.grantRead(this.authorizerHandler);
    // The authorizer only reads hashed keys to validate a presented one.
    apiKeysTable.grantReadData(this.authorizerHandler);

    this.authorizer = new HttpLambdaAuthorizer('Authorizer', this.authorizerHandler, {
      authorizerName: 'FreeMailAuthorizer',
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      // Dual-scheme (Bearer or x-api-key): no fixed identity source + no caching so
      // the function always runs and inspects whichever header carries the credential.
      identitySource: [],
      resultsCacheTtl: Duration.seconds(0),
    });

    this.restIntegration = new HttpLambdaIntegration('RestIntegration', this.restHandler);

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'FreeMail',
      description: 'FreeMail REST + MCP API.',
      // Bearer tokens (not cookies) → no credentials, so a wildcard origin is safe
      // and lets the SPA call the API before a custom app domain is configured.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['authorization', 'content-type'],
      },
    });

    // Public (no token yet): set-password, login, refresh, logout.
    this.addRestRoute('/auth/set-password', apigwv2.HttpMethod.POST);
    this.addRestRoute('/auth/login', apigwv2.HttpMethod.POST);
    this.addRestRoute('/auth/refresh', apigwv2.HttpMethod.POST);
    this.addRestRoute('/auth/logout', apigwv2.HttpMethod.POST);
    // Protected sample route — proves the authorizer end to end.
    this.addRestRoute('/me', apigwv2.HttpMethod.GET, { authorized: true });

    // Agent API-key management (access-token authed).
    this.addRestRoute('/keys', apigwv2.HttpMethod.POST, { authorized: true });
    this.addRestRoute('/keys', apigwv2.HttpMethod.GET, { authorized: true });
    this.addRestRoute('/keys/{id}', apigwv2.HttpMethod.DELETE, { authorized: true });

    // Send email — dual-scheme (Bearer human OR x-api-key agent), so it's behind
    // the authorizer but the handler does NOT restrict it to the access scheme.
    this.addRestRoute('/emails', apigwv2.HttpMethod.POST, { authorized: true });

    // Read the mailbox (access-token only — the handler enforces the scheme): list the
    // merged timeline, read one message, and mint a presigned attachment download URL.
    this.addRestRoute('/emails', apigwv2.HttpMethod.GET, { authorized: true });
    this.addRestRoute('/emails/{id}', apigwv2.HttpMethod.GET, { authorized: true });
    this.addRestRoute('/emails/{id}/attachments/{attachmentId}', apigwv2.HttpMethod.GET, {
      authorized: true,
    });

    // MCP server (agents) — its own handler behind the SAME dual-scheme authorizer.
    // Both schemes resolve to the owner and `send_email` is the same capability as
    // POST /emails, so no scheme guard is needed. Stateless JSON tool-calling is
    // request/response, so only POST is registered (no GET/SSE stream).
    this.httpApi.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('McpIntegration', this.mcpHandler),
      authorizer: this.authorizer,
    });
  }

  /**
   * Add a route served by the shared REST handler. `authorized` puts it behind the
   * dual-scheme authorizer. Later REST slices (#6) call this; the MCP slice (#7)
   * adds its own integration via `httpApi`/`authorizer` directly.
   */
  addRestRoute(
    path: string,
    method: apigwv2.HttpMethod,
    opts: { authorized?: boolean } = {},
  ): void {
    this.httpApi.addRoutes({
      path,
      methods: [method],
      integration: this.restIntegration,
      ...(opts.authorized ? { authorizer: this.authorizer } : {}),
    });
  }

  /**
   * Grant a handler SES send under the domain identity (SES domain identities cover
   * subdomains too). `SendEmail` with raw content also authorizes `SendRawEmail`.
   * Shared by the REST send route and the MCP server, which send through the same
   * EmailService.
   */
  private grantSesSend(fn: nodejs.NodejsFunction, emailDomain: string): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: emailDomain,
          }),
        ],
      }),
    );
  }

  private nodeFunction(
    id: string,
    entryFile: string,
    props: {
      description: string;
      environment: Record<string, string>;
      memorySize?: number;
    },
  ): nodejs.NodejsFunction {
    return new nodejs.NodejsFunction(this, id, {
      entry: join(HANDLERS_DIR, entryFile),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: props.memorySize ?? 256,
      description: props.description,
      environment: props.environment,
      // Bundle everything (incl. the AWS SDK v3 clients) rather than relying on the
      // runtime-provided SDK, so the deployed version is pinned and reproducible.
    });
  }
}
