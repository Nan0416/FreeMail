import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared';
import { FreeMailStack } from '../freemail-stack.js';

const config: FreeMailConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

function synth(): Template {
  return Template.fromStack(new FreeMailStack(new App(), 'TestStack', { config }));
}

describe('ApiConstruct', () => {
  it('stands up one HTTP API with an auto-generated signing key', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { PasswordLength: 64 },
    });
    template.hasOutput('ApiEndpoint', {});
  });

  it('configures NO CORS (the web app is same-origin via the CloudFront /api proxy)', () => {
    const template = synth();
    // The wildcard was removed, not replaced — a same-origin API grants the browser
    // no cross-origin access, and ambient SameSite=Strict cookies never reach this host.
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.absent(),
    });
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

  it('exposes 13 routes: 4 public auth + 9 protected (me + 3 keys + send + 3 reads + mcp)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 13);
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    const authorizationTypes = routes.map((r) => r.Properties.AuthorizationType);
    expect(authorizationTypes.filter((t) => t === 'CUSTOM')).toHaveLength(9);
    expect(authorizationTypes.filter((t) => t !== 'CUSTOM')).toHaveLength(4);
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
          SIGNING_KEY_SECRET_ID: Match.anyValue(),
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

  it('runs the MCP handler with only email env — no auth/keys tables or signing key', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('MCP'),
      Environment: {
        Variables: Match.objectLike({
          EMAILS_TABLE: Match.anyValue(),
          EMAIL_DOMAIN: 'example.com',
          // Authentication is the shared authorizer's job — the MCP handler needs none of these.
          AUTH_TABLE: Match.absent(),
          API_KEYS_TABLE: Match.absent(),
          // Reads are the REST surface — the MCP (send-only) handler gets no mail-bucket access.
          MAIL_BUCKET: Match.absent(),
          SIGNING_KEY_SECRET_ID: Match.absent(),
        }),
      },
    });
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

  it('grants the handlers read access to the signing key secret', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          }),
        ]),
      },
    });
  });
});
