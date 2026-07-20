import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Duration,
  Stack,
  aws_apigatewayv2 as apigwv2,
  aws_certificatemanager as acm,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import type { CustomDomainProps } from './web.js';

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
  readonly authTable: dynamodb.Table;
  /** Hashed agent API keys — the REST handler manages them; the authorizer validates presented keys. */
  readonly apiKeysTable: dynamodb.Table;
  /** Sent/inbound email metadata — the send route records sent messages, the read routes list/get them. */
  readonly emailsTable: dynamodb.Table;
  /** Outbound large-attachment download tokens (#14) — send mints them, `GET /d/{token}` claims them. */
  readonly downloadTokensTable: dynamodb.Table;
  /** Inbound raw MIME + extracted attachments + outbound large attachments (send writes, reads presign). */
  readonly mailBucket: s3.IBucket;
  /** The SES send domain — `from` must be under it, and it scopes the send IAM grant. */
  readonly emailDomain: string;
  /** SES configuration set the send route routes through (suppression + bounce/complaint tracking). */
  readonly sesConfigurationSetName: string;
  /**
   * Whether inbound email is enabled. Gates the MCP read tools (#13): when true, the MCP
   * handler gets `INBOUND_ENABLED='true'` plus read-only grants scoped to exactly what the
   * read service touches (emails table + the inbound raw/attachment prefixes). When false,
   * the read tools are never registered and no read grants are added.
   */
  readonly inboundEnabled: boolean;
  /**
   * Optional custom domain for the API (from `FreeMailConfig.apiDomain`), for DIRECT
   * agent/MCP (`x-api-key`) access at a stable branded host. When set, a DNS-validated
   * ACM cert + a regional API Gateway v2 custom domain + alias records are created;
   * omitted → the generated `execute-api` URL (no cert/DNS resources). This is
   * independent of the web app: the SPA reaches the API SAME-ORIGIN through the
   * CloudFront `/api/*` proxy (which targets the generated endpoint), so this custom
   * domain is never used by the browser and does not affect the #31 cookie auth.
   */
  readonly customDomain?: CustomDomainProps;
}

/**
 * The HTTP API skeleton: one HTTP API fronted by a dual-scheme Lambda authorizer,
 * with the auth routes (public), a protected `GET /me`, the `/keys` management routes,
 * send/read routes, and the public `GET /d/{token}` large-attachment download (#14),
 * all wired to a single REST handler. The MCP server (#7) adds its own route +
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
  /** The configured custom API domain, if any (from `FreeMailConfig.apiDomain`). */
  readonly customDomainName?: string;
  private readonly restIntegration: HttpLambdaIntegration;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);
    const {
      authTable,
      apiKeysTable,
      emailsTable,
      downloadTokensTable,
      mailBucket,
      emailDomain,
      sesConfigurationSetName,
      inboundEnabled,
      customDomain,
    } = props;

    this.signingKey = new secretsmanager.Secret(this, 'JwtSigningKey', {
      description: 'HS256 signing key for FreeMail access tokens.',
      // Generated at deploy → the "one cdk deploy" UX needs no out-of-band secret.
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // Created before the handlers so its endpoint can be baked into their env as the
    // public base for `/d/{token}` download links (DOWNLOAD_BASE_URL). The Api resource
    // itself has no dependency on the handlers (only the Routes do), so this is acyclic.
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'FreeMail',
      description: 'FreeMail REST + MCP API.',
      // NO CORS (#31): the web app calls the API SAME-ORIGIN through the CloudFront
      // `/api/*` proxy, so the browser never makes a cross-origin request and never
      // needs cross-origin permission. The wildcard was removed rather than replaced
      // — a same-origin API grants no browser cross-origin access at all. The direct
      // API Gateway URL stays reachable by non-browser `x-api-key` (MCP) callers,
      // which are not subject to CORS; ambient SameSite=Strict cookies are never sent
      // to this host, so there is no CSRF surface here.
    });

    this.restHandler = this.nodeFunction('RestHandler', 'rest.ts', {
      description: 'FreeMail REST API (auth + app routes).',
      memorySize: 1024, // more vCPU so the scrypt hash on login stays sub-second
      environment: {
        AUTH_TABLE: authTable.tableName,
        API_KEYS_TABLE: apiKeysTable.tableName,
        EMAILS_TABLE: emailsTable.tableName,
        DOWNLOAD_TOKENS_TABLE: downloadTokensTable.tableName,
        MAIL_BUCKET: mailBucket.bucketName,
        EMAIL_DOMAIN: emailDomain,
        SES_CONFIGURATION_SET: sesConfigurationSetName,
        SIGNING_KEY_SECRET_ID: this.signingKey.secretName,
        // Public base for `/d/{token}` links — the API's own endpoint (no bucket exposure).
        DOWNLOAD_BASE_URL: this.httpApi.apiEndpoint,
      },
    });
    authTable.grantReadWriteData(this.restHandler);
    // The REST handler mints, lists, and revokes keys.
    apiKeysTable.grantReadWriteData(this.restHandler);
    // The send route records sent-email metadata; the read routes list/get it.
    emailsTable.grantReadWriteData(this.restHandler);
    // Large-attachment tokens: send mints them, GET /d/{token} claims (conditional update).
    downloadTokensTable.grantReadWriteData(this.restHandler);
    // The read routes re-parse raw inbound MIME (for bodies) and presign attachment
    // downloads — scoped to the inbound raw + extracted-attachment prefixes only.
    mailBucket.grantRead(this.restHandler, 'inbound/*');
    mailBucket.grantRead(this.restHandler, 'attachments/inbound/*');
    // Outbound large attachments: the send route writes them, GET /d/{token} presigns them.
    mailBucket.grantReadWrite(this.restHandler, 'attachments/outbound/*');
    this.signingKey.grantRead(this.restHandler);

    // The REST `/emails` route sends.
    this.grantSesSend(this.restHandler, emailDomain);

    // MCP server: its own handler, but reuses the same EmailService (send) and, when
    // inbound is enabled, the same EmailReadService (#13 read tools). It gets the
    // emails-table write + SES send grants + (for large attachments) the download-tokens
    // table + outbound prefix; the read grants are added ONLY when inbound is enabled.
    // It does NOT touch auth/keys tables or the signing key — auth is the authorizer's job.
    this.mcpHandler = this.nodeFunction('McpHandler', 'mcp.ts', {
      description: 'FreeMail MCP server (send_email + read tools).',
      memorySize: 512,
      environment: {
        EMAILS_TABLE: emailsTable.tableName,
        DOWNLOAD_TOKENS_TABLE: downloadTokensTable.tableName,
        MAIL_BUCKET: mailBucket.bucketName,
        EMAIL_DOMAIN: emailDomain,
        SES_CONFIGURATION_SET: sesConfigurationSetName,
        DOWNLOAD_BASE_URL: this.httpApi.apiEndpoint,
        // Gates the read tools (#13); the handler treats only exactly 'true' as enabled.
        INBOUND_ENABLED: String(inboundEnabled),
      },
    });
    emailsTable.grantWriteData(this.mcpHandler);
    // Send-only: mint tokens + upload the bytes; the MCP handler never serves downloads.
    downloadTokensTable.grantWriteData(this.mcpHandler);
    mailBucket.grantWrite(this.mcpHandler, 'attachments/outbound/*');
    this.grantSesSend(this.mcpHandler, emailDomain);
    // #13 read tools: read-only access scoped to exactly what EmailReadService touches —
    // the emails table (list/get) and the inbound raw MIME + extracted-attachment prefixes
    // (body re-parse + attachment presign). Added only when inbound is enabled.
    if (inboundEnabled) {
      emailsTable.grantReadData(this.mcpHandler);
      mailBucket.grantRead(this.mcpHandler, 'inbound/*');
      mailBucket.grantRead(this.mcpHandler, 'attachments/inbound/*');
    }

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

    // Outbound large-attachment download (#14) — PUBLIC (no authorizer): the token IS the
    // capability. The handler validates it and 302s to a short-lived presigned GET, or
    // returns a uniform 404 for any unknown/expired/revoked/exhausted token.
    this.addRestRoute('/d/{token}', apigwv2.HttpMethod.GET);

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

    // Optional custom API domain for direct agent/MCP callers. A DNS-validated ACM
    // cert (in the stack region — a REGIONAL HTTP-API custom domain requires the cert
    // in the API's own region, which the us-east-1 pin satisfies) + a regional custom
    // domain mapped to the default stage + alias records. The generated `execute-api`
    // URL keeps working (the CloudFront `/api/*` proxy still targets it), so the SPA is
    // unaffected — this domain is a same-target alias for external callers only.
    if (customDomain) {
      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName: customDomain.domainName,
        validation: acm.CertificateValidation.fromDns(customDomain.hostedZone),
      });
      const domainName = new apigwv2.DomainName(this, 'DomainName', {
        domainName: customDomain.domainName,
        certificate,
      });
      new apigwv2.ApiMapping(this, 'ApiMapping', {
        api: this.httpApi,
        domainName,
        stage: this.httpApi.defaultStage,
      });
      const aliasTarget = route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          domainName.regionalDomainName,
          domainName.regionalHostedZoneId,
        ),
      );
      new route53.ARecord(this, 'AliasRecord', {
        zone: customDomain.hostedZone,
        recordName: customDomain.domainName,
        target: aliasTarget,
      });
      new route53.AaaaRecord(this, 'AliasRecordAaaa', {
        zone: customDomain.hostedZone,
        recordName: customDomain.domainName,
        target: aliasTarget,
      });
      this.customDomainName = customDomain.domainName;
    }
  }

  /**
   * Add a route served by the shared REST handler. `authorized` puts it behind the
   * dual-scheme authorizer; omit it for a public route.
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
