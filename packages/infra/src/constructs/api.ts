import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Duration,
  aws_apigatewayv2 as apigwv2,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
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
  /** Auto-generated HS256 signing key (no manual bootstrap step). */
  readonly signingKey: secretsmanager.Secret;
  private readonly restIntegration: HttpLambdaIntegration;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);
    const { authTable, apiKeysTable } = props;

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
        SIGNING_KEY_SECRET_ID: this.signingKey.secretName,
      },
    });
    authTable.grantReadWriteData(this.restHandler);
    // The REST handler mints, lists, and revokes keys.
    apiKeysTable.grantReadWriteData(this.restHandler);
    this.signingKey.grantRead(this.restHandler);

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
