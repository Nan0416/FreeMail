import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack } from 'aws-cdk-lib';
import {
  ApiMapping,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
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
  readonly authTable: Table;
  /** Hashed agent API keys — the REST handler manages them; the authorizer validates presented keys. */
  readonly apiKeysTable: Table;
  /** Sent/inbound email metadata — the send route records sent messages, the read routes list/get them. */
  readonly emailsTable: Table;
  /** Outbound large-attachment download tokens (#14) — send mints them, `GET /d/{token}` claims them. */
  readonly downloadTokensTable: Table;
  /** Inbound raw MIME + extracted attachments, sent MIME + attachment copies, outbound large attachments. */
  readonly mailBucket: IBucket;
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
   * The API's custom domain (from `FreeMailConfig.apiDomain`). REQUIRED as of #47: this
   * is where BOTH the browser and agents reach the API, and the session cookies are
   * host-locked to it. A DNS-validated ACM cert + a regional API Gateway v2 custom
   * domain + alias records are created; there is no generated-`execute-api` fallback.
   */
  readonly customDomain: CustomDomainProps;
  /**
   * The SPA's origin (`https://<appDomain>`) — the single value allowlisted by the
   * credentialed CORS policy (#47). Exactly one origin, never a wildcard or a reflected
   * request origin.
   */
  readonly appOrigin: string;
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
  readonly httpApi: HttpApi;
  readonly authorizer: HttpLambdaAuthorizer;
  readonly restHandler: NodejsFunction;
  readonly authorizerHandler: NodejsFunction;
  /** MCP server (agent-facing `send_email` tool) — its own handler behind the shared authorizer. */
  readonly mcpHandler: NodejsFunction;
  /** The API's custom domain (from `FreeMailConfig.apiDomain`) — always set as of #47. */
  readonly customDomainName: string;
  private readonly restIntegration: HttpLambdaIntegration;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    // Created before the handlers so its endpoint can be baked into their env as the
    // public base for `/d/{token}` download links (DOWNLOAD_BASE_URL). The Api resource
    // itself has no dependency on the handlers (only the Routes do), so this is acyclic.
    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: 'FreeMail',
      description: 'FreeMail REST + MCP API.',
      // Credentialed CORS locked to the ONE canonical SPA origin (#47, supersedes the
      // #31 same-origin-proxy model). This is Layer 2 of the three-layer model: the
      // response-READ boundary, and the preflight denial that stops a same-site sibling
      // once Layer 3 (the handlers' application/json gate) has forced that preflight.
      //
      // Managed API-Gateway CORS rather than a Lambda-side helper for one decisive
      // reason: an authorizer DENY is generated by API Gateway BEFORE the integration
      // runs, so a Lambda helper could never attach Access-Control-Allow-Origin to it —
      // and the SPA's transparent-refresh flow depends on being able to READ that 403
      // to know its access cookie expired (see web/src/api/client.ts). See
      // docs/CORS-VERIFICATION.md: this behavior is a claim to verify on the first real
      // deploy, not an established fact.
      //
      // Exact single origin, never a wildcard and never reflected. Credentials are
      // allowed ONLY alongside that origin. CORS is not request authorization: a
      // non-matching or absent Origin merely gets no usable CORS headers — the request
      // still reaches the authorizer, which is why no-Origin `x-api-key` agent calls
      // are entirely unaffected.
      corsPreflight: {
        allowOrigins: [props.appOrigin],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        // Only what the SPA actually sends. `content-type` is required because Layer 3
        // makes every cookie-authenticated mutation carry `application/json`.
        allowHeaders: ['content-type'],
        allowCredentials: true,
        maxAge: Duration.hours(1),
      },
    });

    this.restHandler = this.nodeFunction('RestHandler', 'service-handler.ts', {
      description: 'FreeMail REST API (auth + app routes).',
      memorySize: 1024, // more vCPU so the scrypt hash on login stays sub-second
      environment: {
        AUTH_TABLE: props.authTable.tableName,
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        EMAILS_TABLE: props.emailsTable.tableName,
        DOWNLOAD_TOKENS_TABLE: props.downloadTokensTable.tableName,
        MAIL_BUCKET: props.mailBucket.bucketName,
        EMAIL_DOMAIN: props.emailDomain,
        SES_CONFIGURATION_SET: props.sesConfigurationSetName,
        // Public base for `/d/{token}` links — the API's own endpoint (no bucket exposure).
        DOWNLOAD_BASE_URL: this.httpApi.apiEndpoint,
      },
    });
    props.authTable.grantReadWriteData(this.restHandler);
    // The REST handler mints, lists, and revokes keys.
    props.apiKeysTable.grantReadWriteData(this.restHandler);
    // The send route records sent-email metadata; the read routes list/get it.
    props.emailsTable.grantReadWriteData(this.restHandler);
    // Large-attachment tokens: send mints them, GET /d/{token} claims (conditional update).
    props.downloadTokensTable.grantReadWriteData(this.restHandler);
    // The read routes presign the original (.eml) and attachment downloads, and re-parse raw
    // inbound MIME only for a legacy row with no stored body — scoped to these prefixes only.
    props.mailBucket.grantRead(this.restHandler, 'inbound/*');
    props.mailBucket.grantRead(this.restHandler, 'attachments/inbound/*');
    // Outbound large attachments: the send route writes them, GET /d/{token} presigns them.
    props.mailBucket.grantReadWrite(this.restHandler, 'attachments/outbound/*');
    // Sent raw MIME archive (#29): the send route writes it; the read routes presign it as the
    // .eml download and re-parse it only for a legacy row with no stored body.
    props.mailBucket.grantReadWrite(this.restHandler, 'sent/*');
    // Sent embedded-attachment copies: the send route writes them; the attachment route
    // presigns them (linked ones are presigned from attachments/outbound/*, granted above).
    props.mailBucket.grantReadWrite(this.restHandler, 'attachments/sent/*');
    // Stored bodies: the send route writes a large sent body; the read route loads any
    // stored body (inbound bodies are written by the parser).
    props.mailBucket.grantPut(this.restHandler, 'bodies/sent/*');
    props.mailBucket.grantRead(this.restHandler, 'bodies/*');

    // The REST `/emails` route sends.
    this.grantSesSend(this.restHandler, props.emailDomain, props.sesConfigurationSetName);

    // MCP server: its own handler, but reuses the same EmailService (send) and, when
    // inbound is enabled, the same EmailReadService (#13 read tools). It gets the
    // emails-table write + SES send grants + (for large attachments) the download-tokens
    // table + outbound prefix; the read grants are added ONLY when inbound is enabled.
    // It does NOT touch auth/keys tables or the signing key — auth is the authorizer's job.
    this.mcpHandler = this.nodeFunction('McpHandler', 'mcp.ts', {
      description: 'FreeMail MCP server (send_email + read tools).',
      memorySize: 512,
      environment: {
        EMAILS_TABLE: props.emailsTable.tableName,
        DOWNLOAD_TOKENS_TABLE: props.downloadTokensTable.tableName,
        MAIL_BUCKET: props.mailBucket.bucketName,
        EMAIL_DOMAIN: props.emailDomain,
        SES_CONFIGURATION_SET: props.sesConfigurationSetName,
        DOWNLOAD_BASE_URL: this.httpApi.apiEndpoint,
        // Gates the read tools (#13); the handler treats only exactly 'true' as enabled.
        INBOUND_ENABLED: String(props.inboundEnabled),
      },
    });
    props.emailsTable.grantWriteData(this.mcpHandler);
    // Send-only: mint tokens + upload the bytes; the MCP handler never serves downloads.
    props.downloadTokensTable.grantWriteData(this.mcpHandler);
    props.mailBucket.grantWrite(this.mcpHandler, 'attachments/outbound/*');
    // Sent raw MIME archive (#29): send_email writes it. Write-only here — reading it back is
    // the get_email path, granted below only when inbound (and thus the read tools) is enabled.
    props.mailBucket.grantWrite(this.mcpHandler, 'sent/*');
    // Sent embedded-attachment copies: send_email writes them (read granted below, like sent/*).
    props.mailBucket.grantWrite(this.mcpHandler, 'attachments/sent/*');
    // A large sent body: send_email writes it (read granted below, with the read tools).
    props.mailBucket.grantPut(this.mcpHandler, 'bodies/sent/*');
    this.grantSesSend(this.mcpHandler, props.emailDomain, props.sesConfigurationSetName);
    // #13 read tools: read-only access scoped to exactly what EmailReadService touches —
    // the emails table (list/get), stored bodies, the inbound raw MIME + extracted-attachment
    // prefixes and the sent raw MIME archive (#29) (legacy body re-parse + presigns), and the
    // sent attachments — embedded copies + linked large uploads — for get_email_attachment_url.
    // Added only when inbound is enabled (fail-closed, gates get_email too).
    if (props.inboundEnabled) {
      props.emailsTable.grantReadData(this.mcpHandler);
      props.mailBucket.grantRead(this.mcpHandler, 'inbound/*');
      props.mailBucket.grantRead(this.mcpHandler, 'attachments/inbound/*');
      props.mailBucket.grantRead(this.mcpHandler, 'sent/*');
      props.mailBucket.grantRead(this.mcpHandler, 'attachments/sent/*');
      props.mailBucket.grantRead(this.mcpHandler, 'attachments/outbound/*');
      props.mailBucket.grantRead(this.mcpHandler, 'bodies/*');
    }

    this.authorizerHandler = this.nodeFunction('AuthorizerHandler', 'authorizer.ts', {
      description: 'FreeMail Lambda authorizer (access tokens + API keys).',
      environment: {
        API_KEYS_TABLE: props.apiKeysTable.tableName,
        AUTH_TABLE: props.authTable.tableName,
      },
    });
    // The authorizer only reads hashed keys to validate a presented one.
    props.apiKeysTable.grantReadData(this.authorizerHandler);
    // Read-only on the auth table for the HS256 signing key (#42 item 1b). The REST
    // handler generates and persists it; the authorizer never writes and fails closed
    // when the row is absent.
    props.authTable.grantReadData(this.authorizerHandler);

    this.authorizer = new HttpLambdaAuthorizer('Authorizer', this.authorizerHandler, {
      authorizerName: 'FreeMailAuthorizer',
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      // Dual-scheme (Bearer or x-api-key): no fixed identity source + no caching so
      // the function always runs and inspects whichever header carries the credential.
      identitySource: [],
      resultsCacheTtl: Duration.seconds(0),
    });

    this.restIntegration = new HttpLambdaIntegration('RestIntegration', this.restHandler);

    // Public (no token yet): login (which enrolls on first use, #42), refresh, logout.
    this.addRestRoute('/auth/login', HttpMethod.POST);
    this.addRestRoute('/auth/refresh', HttpMethod.POST);
    this.addRestRoute('/auth/logout', HttpMethod.POST);
    // Protected sample route — proves the authorizer end to end.
    this.addRestRoute('/me', HttpMethod.GET, { authorized: true });

    // Agent API-key management (access-token authed).
    this.addRestRoute('/keys', HttpMethod.POST, { authorized: true });
    this.addRestRoute('/keys', HttpMethod.GET, { authorized: true });
    this.addRestRoute('/keys/{id}', HttpMethod.DELETE, { authorized: true });

    // Send email — dual-scheme (Bearer human OR x-api-key agent), so it's behind
    // the authorizer but the handler does NOT restrict it to the access scheme.
    this.addRestRoute('/emails', HttpMethod.POST, { authorized: true });

    // Read the mailbox (access-token only — the handler enforces the scheme): list the
    // merged timeline, read one message, and mint a presigned download URL for an attachment
    // or for the original message (.eml — re-uses the inbound/* + sent/* read grants above).
    this.addRestRoute('/emails', HttpMethod.GET, { authorized: true });
    this.addRestRoute('/emails/{id}', HttpMethod.GET, { authorized: true });
    this.addRestRoute('/emails/{id}/attachments/{attachmentId}', HttpMethod.GET, {
      authorized: true,
    });
    this.addRestRoute('/emails/{id}/raw', HttpMethod.GET, { authorized: true });

    // Outbound large-attachment download (#14) — PUBLIC (no authorizer): the token IS the
    // capability. The handler validates it and 302s to a short-lived presigned GET, or
    // returns a uniform 404 for any unknown/expired/revoked/exhausted token.
    this.addRestRoute('/d/{token}', HttpMethod.GET);

    // MCP server (agents) — its own handler behind the SAME dual-scheme authorizer.
    // Both schemes resolve to the owner and `send_email` is the same capability as
    // POST /emails, so no scheme guard is needed. Stateless JSON tool-calling is
    // request/response, so only POST is registered (no GET/SSE stream).
    this.httpApi.addRoutes({
      path: '/mcp',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('McpIntegration', this.mcpHandler),
      authorizer: this.authorizer,
    });

    // The API's custom domain — where the browser AND agents both reach it (#47). A
    // DNS-validated ACM cert (in the stack region — a REGIONAL HTTP-API custom domain
    // requires the cert in the API's own region, which the us-east-1 pin satisfies) + a
    // regional custom domain mapped to the default stage + alias records. The generated
    // `execute-api` URL keeps working, but nothing depends on it any more: the session
    // cookies are `__Host-` and therefore host-locked to THIS domain.
    const certificate = new Certificate(this, 'Certificate', {
      domainName: props.customDomain.domainName,
      validation: CertificateValidation.fromDns(props.customDomain.hostedZone),
    });
    const domainName = new DomainName(this, 'DomainName', {
      domainName: props.customDomain.domainName,
      certificate,
    });
    new ApiMapping(this, 'ApiMapping', {
      api: this.httpApi,
      domainName,
      stage: this.httpApi.defaultStage,
    });
    const aliasTarget = RecordTarget.fromAlias(
      new ApiGatewayv2DomainProperties(
        domainName.regionalDomainName,
        domainName.regionalHostedZoneId,
      ),
    );
    new ARecord(this, 'AliasRecord', {
      zone: props.customDomain.hostedZone,
      recordName: props.customDomain.domainName,
      target: aliasTarget,
    });
    new AaaaRecord(this, 'AliasRecordAaaa', {
      zone: props.customDomain.hostedZone,
      recordName: props.customDomain.domainName,
      target: aliasTarget,
    });
    this.customDomainName = props.customDomain.domainName;
  }

  /**
   * Add a route served by the shared REST handler. `authorized` puts it behind the
   * dual-scheme authorizer; omit it for a public route.
   */
  addRestRoute(path: string, method: HttpMethod, opts: { authorized?: boolean } = {}): void {
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
   *
   * BOTH the identity and the configuration-set ARN are required. The sender passes
   * `ConfigurationSetName` on every call (that is how suppression and bounce/complaint
   * events keep working in sesIdentity `import` mode), and SES authorizes such a send
   * against the configuration-set resource as well as the identity. Granting the
   * identity alone fails at runtime, not at deploy, with a 403 AccessDeniedException
   * naming the configuration set.
   */
  private grantSesSend(
    fn: NodejsFunction,
    emailDomain: string,
    configurationSetName: string,
  ): void {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: emailDomain,
          }),
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: configurationSetName,
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
  ): NodejsFunction {
    return new NodejsFunction(this, id, {
      entry: join(HANDLERS_DIR, entryFile),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: props.memorySize ?? 256,
      description: props.description,
      environment: props.environment,
      // Bundle everything (incl. the AWS SDK v3 clients) rather than relying on the
      // runtime-provided SDK, so the deployed version is pinned and reproducible.
    });
  }
}
