import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared/config';
import { FreeMailStack } from '../../src/freemail-stack.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

function synth(): Template {
  return Template.fromStack(new FreeMailStack(new App(), 'TestStack', { config }));
}

/** Alias for readability where a test inspects raw resources rather than matching. */
function template(): Template {
  return synth();
}

/** Synth with inbound enabled (and its MX acknowledgement) so the #13 read grants are added. */
function synthWithInbound(): Template {
  return Template.fromStack(
    new FreeMailStack(new App(), 'TestStack', {
      config: { ...config, inbound: { enabled: true, confirmInboundMx: true } },
    }),
  );
}

const MCP_DESCRIPTION = 'FreeMail MCP server (send_email + read tools).';

/** All IAM policy statements attached to a Lambda function's execution role, by description. */
function roleActions(template: Template, description: string): string[] {
  const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
    (f) => f.Properties?.Description === description,
  );
  const roleRef = (fn?.Properties?.Role as { 'Fn::GetAtt'?: [string, string] } | undefined)?.[
    'Fn::GetAtt'
  ]?.[0];
  expect(roleRef).toBeDefined();
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) =>
      ((p.Properties?.Roles as { Ref?: string }[] | undefined) ?? []).some(
        (r) => r.Ref === roleRef,
      ),
    )
    .flatMap((p) => (p.Properties?.PolicyDocument?.Statement ?? []) as { Action: unknown }[]);
  return statements
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
    .filter((a): a is string => typeof a === 'string');
}

describe('ApiConstruct', () => {
  it('stands up one HTTP API and no Secrets Manager secret (#42 — the signing key lives in authTable)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.hasOutput('ApiEndpoint', {});
  });

  it('locks credentialed CORS to the ONE canonical app origin (#47)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowOrigins: ['https://app.example.com'],
        AllowCredentials: true,
        AllowHeaders: ['content-type'],
        AllowMethods: Match.arrayWith(['GET', 'POST', 'DELETE', 'OPTIONS']),
      },
    });
  });

  it('never allows a wildcard origin or wildcard headers alongside credentials', () => {
    // `Access-Control-Allow-Credentials: true` with `*` is the classic footgun — the
    // browser rejects it outright, and any reflection here would defeat the whole
    // same-site-sibling defense.
    const api = Object.values(template().findResources('AWS::ApiGatewayV2::Api'))[0];
    const cors = api?.Properties?.CorsConfiguration as {
      AllowOrigins?: string[];
      AllowHeaders?: string[];
      AllowMethods?: string[];
    };
    expect(cors.AllowOrigins).not.toContain('*');
    expect(cors.AllowHeaders).not.toContain('*');
    expect(cors.AllowMethods).not.toContain('*');
    // Exactly one origin — never a list that could drift into reflection.
    expect(cors.AllowOrigins).toHaveLength(1);
  });

  it('enables NO API-Gateway access logging (so the Cookie header can never be logged)', () => {
    const template = synth();
    // Both credentials now ride the Cookie header on every request; access logging is
    // off entirely, so no access log can capture or leak it.
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.absent(),
    });
  });

  it('wires a dual-scheme SIMPLE request authorizer', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      EnableSimpleResponses: true,
      AuthorizerPayloadFormatVersion: '2.0',
    });
  });

  it('exposes 13 routes: 4 public (3 auth + download) + 9 protected (me + 3 keys + send + 3 reads + mcp)', () => {
    const template = synth();
    // 3 auth routes, not 4: #42 folded enrollment into login and dropped /auth/set-password.
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 13);
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    const authorizationTypes = routes.map((r) => r.Properties.AuthorizationType);
    // The public GET /d/{token} download is unauthenticated (the token is the capability).
    expect(authorizationTypes.filter((t) => t === 'CUSTOM')).toHaveLength(9);
    expect(authorizationTypes.filter((t) => t !== 'CUSTOM')).toHaveLength(4);
  });

  it('registers GET /d/{token} as a PUBLIC route (no authorizer)', () => {
    const template = synth();
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    const download = routes.find((r) => r.Properties.RouteKey === 'GET /d/{token}');
    expect(download).toBeDefined();
    expect(download?.Properties.AuthorizationType).not.toBe('CUSTOM');
    expect(download?.Properties.AuthorizerId).toBeUndefined();
  });

  it('grants the REST handler SES send permission scoped to an identity (not *)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            // Scoped to the domain identity ARN (a token), never a bare '*'.
            Resource: Match.not('*'),
          }),
        ]),
      },
    });
  });

  it('runs both handlers on arm64 Node 22 with the expected environment', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({
          AUTH_TABLE: Match.anyValue(),
          API_KEYS_TABLE: Match.anyValue(),
          // The read routes need the mail bucket (raw MIME re-parse + attachment presign).
          MAIL_BUCKET: Match.anyValue(),
          // Large-attachment (#14): token store + the public base for /d/{token} links.
          DOWNLOAD_TOKENS_TABLE: Match.anyValue(),
          DOWNLOAD_BASE_URL: Match.anyValue(),
        }),
      },
    });
  });

  it('grants the REST handler read access to the mail bucket (for body re-parse + presign)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]),
          }),
        ]),
      },
    });
  });

  it('runs the MCP handler with send env (incl. large-attachment) but no auth/keys tables or signing key', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('MCP'),
      Environment: {
        Variables: Match.objectLike({
          EMAILS_TABLE: Match.anyValue(),
          EMAIL_DOMAIN: 'example.com',
          // Large-attachment (#14) send needs the mail bucket (upload) + token store + link base.
          MAIL_BUCKET: Match.anyValue(),
          DOWNLOAD_TOKENS_TABLE: Match.anyValue(),
          DOWNLOAD_BASE_URL: Match.anyValue(),
          // #13 read-tool gate — off in this config (inbound disabled).
          INBOUND_ENABLED: 'false',
          // Authentication is the shared authorizer's job — the MCP handler needs none of these.
          AUTH_TABLE: Match.absent(),
          API_KEYS_TABLE: Match.absent(),
        }),
      },
    });
  });

  it('with inbound OFF, the MCP role is send-only — no email-table read, no mail-bucket read', () => {
    // Inbound disabled → the read tools are never registered, so the MCP handler must not
    // hold read grants: no s3:GetObject and no DynamoDB read actions. Its send-path write
    // grants (outbound attachment PutObject, emails-table write) remain.
    const actions = roleActions(synth(), MCP_DESCRIPTION);
    expect(actions).toContain('s3:PutObject');
    expect(actions.some((a) => a.startsWith('s3:GetObject'))).toBe(false);
    expect(actions).not.toContain('dynamodb:GetItem');
    expect(actions).not.toContain('dynamodb:Query');
  });

  it('with inbound ON, grants the MCP role read-only email + inbound-prefix access and sets INBOUND_ENABLED=true', () => {
    const template = synthWithInbound();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: MCP_DESCRIPTION,
      Environment: { Variables: Match.objectLike({ INBOUND_ENABLED: 'true' }) },
    });
    // Read tools now reach the emails table (Query/GetItem) and the mail bucket (GetObject
    // for body re-parse + attachment presign), while keeping the send-path write grants.
    const actions = roleActions(template, MCP_DESCRIPTION);
    expect(actions.some((a) => a.startsWith('s3:GetObject'))).toBe(true);
    expect(actions.some((a) => a === 'dynamodb:Query' || a === 'dynamodb:GetItem')).toBe(true);
    expect(actions).toContain('s3:PutObject');
  });

  it('gives the authorizer the API-keys table so it can validate presented keys', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('authorizer'),
      Environment: {
        Variables: Match.objectLike({ API_KEYS_TABLE: Match.anyValue() }),
      },
    });
  });

  it('gives the authorizer the auth table (signing-key read) but never write access to it', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('authorizer'),
      Environment: {
        Variables: Match.objectLike({ AUTH_TABLE: Match.anyValue() }),
      },
    });

    const actions = roleActions(template, 'FreeMail Lambda authorizer (access tokens + API keys).');
    expect(actions).toContain('dynamodb:GetItem');
    // Read-only: the REST handler generates and persists the key; the authorizer
    // verifies with it and fails closed when the row is absent.
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:UpdateItem');
    expect(actions).not.toContain('dynamodb:DeleteItem');
  });
});

describe('ApiConstruct custom domain (apiDomain)', () => {
  function synthWith(overrides: Partial<FreeMailConfig>): Template {
    return Template.fromStack(
      new FreeMailStack(new App(), 'TestStack', { config: { ...config, ...overrides } }),
    );
  }

  it('always wires the custom domain — there is no generated-execute-api fallback (#47)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
  });

  it('wires a REGIONAL custom domain (cert + domain + mapping + A/AAAA) for apiDomain', () => {
    const template = synthWith({ apiDomain: 'api.example.com' });
    // DNS-validated ACM cert — same-region as the regional HTTP-API domain (us-east-1).
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'api.example.com',
      ValidationMethod: 'DNS',
    });
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.example.com',
      DomainNameConfigurations: Match.arrayWith([Match.objectLike({ EndpointType: 'REGIONAL' })]),
    });
    template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
    const aliasRecords = Object.values(template.findResources('AWS::Route53::RecordSet')).filter(
      (r) =>
        r.Properties?.Name === 'api.example.com.' &&
        (r.Properties?.Type === 'A' || r.Properties?.Type === 'AAAA'),
    );
    expect(aliasRecords).toHaveLength(2);
    template.hasOutput('ApiCustomDomainUrl', { Value: 'https://api.example.com' });
  });
});
