import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { FreeMailConfig } from '@freemail/shared/config';
import {
  EMAIL_LIST_INDEX_ATTRIBUTES,
  INBOUND_INGESTED_TAG,
  INBOUND_RAW_RETENTION_DAYS,
} from '@freemail/shared/storage';
import { FreeMailStack } from '../src/freemail-stack.js';

function makeConfig(overrides: Partial<FreeMailConfig> = {}): FreeMailConfig {
  return {
    region: 'us-east-1',
    hostedZone: { mode: 'create', zoneName: 'example.com' },
    emailDomain: 'example.com',
    // Both required as of #47 — the SPA calls the API cross-origin.
    appDomain: 'app.example.com',
    apiDomain: 'api.example.com',
    sesIdentity: { mode: 'create' },
    inbound: { enabled: false, confirmInboundMx: false },
    ...overrides,
  };
}

function synth(config: FreeMailConfig): Template {
  const stack = new FreeMailStack(new App(), 'TestStack', { config });
  return Template.fromStack(stack);
}

/** True when the role named by `rolePrefix` holds `action` on the mail bucket's `prefix` keys. */
function canOnMailPrefix(
  template: Template,
  rolePrefix: string,
  action: string,
  prefix: string,
): boolean {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  return policies.some((policy) => {
    if (!JSON.stringify(policy.Properties.Roles).includes(rolePrefix)) {
      return false;
    }
    return (policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]).some(
      (statement) => {
        const actions = ([] as unknown[]).concat(statement.Action);
        const resources = JSON.stringify(statement.Resource);
        return (
          actions.includes(action) &&
          resources.includes('MailBucket') &&
          resources.includes(`/${prefix}`)
        );
      },
    );
  });
}

/** True when the role named by `rolePrefix` may `dynamodb:Query` the emails table's indexes. */
function canQueryEmailIndexes(template: Template, rolePrefix: string): boolean {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  return policies.some((policy) => {
    const roles = JSON.stringify(policy.Properties.Roles);
    if (!roles.includes(rolePrefix)) {
      return false;
    }
    return (policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]).some(
      (statement) => {
        const actions = ([] as unknown[]).concat(statement.Action);
        const resources = JSON.stringify(statement.Resource);
        return (
          actions.includes('dynamodb:Query') &&
          resources.includes('EmailsTable') &&
          resources.includes('/index/*')
        );
      },
    );
  });
}

describe('FreeMailStack', () => {
  it('pins the stack to the configured region', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    expect(stack.region).toBe('us-east-1');
  });

  it('creates the data layer: 4 tables + 3 buckets — data retained, web disposable', () => {
    const template = synth(makeConfig());
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
    template.resourceCountIs('AWS::S3::Bucket', 3);
    template.allResourcesProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    // Tables + the mail bucket hold the deployer's real data → RETAIN (a cdk destroy
    // must never wipe email). RETAIN is a resource-level DeletionPolicy, not a property.
    for (const resource of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    // Two retained buckets (mail + quarantine) and one disposable bucket (the SPA web bucket,
    // owned by WebConstruct — holds only the redeployable build).
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(buckets.filter((b) => b.DeletionPolicy === 'Retain')).toHaveLength(2);
    expect(buckets.filter((b) => b.DeletionPolicy === 'Delete')).toHaveLength(1);
    // The disposable web bucket is auto-emptied on delete (CFN can't remove a non-empty bucket).
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('gives the emails table a list index that projects only the list fields', () => {
    const template = synth(makeConfig());
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'list',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: [...EMAIL_LIST_INDEX_ATTRIBUTES],
          },
        },
      ],
    });
  });

  it('lets every mailbox reader query the list index', () => {
    // The REST handler always lists; the MCP handler lists only when inbound is enabled.
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    expect(canQueryEmailIndexes(template, 'RestHandler')).toBe(true);
    expect(canQueryEmailIndexes(template, 'McpHandler')).toBe(true);
    // Negative control: the authorizer never touches the emails table.
    expect(canQueryEmailIndexes(template, 'AuthorizerHandler')).toBe(false);
  });

  it('lets every mailbox reader DescribeTable — how the DAO knows the index is ACTIVE', () => {
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    const canDescribe = (rolePrefix: string): boolean =>
      Object.values(template.findResources('AWS::IAM::Policy')).some(
        (policy) =>
          JSON.stringify(policy.Properties.Roles).includes(rolePrefix) &&
          (policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]).some(
            (statement) =>
              ([] as unknown[]).concat(statement.Action).includes('dynamodb:DescribeTable') &&
              JSON.stringify(statement.Resource).includes('EmailsTable'),
          ),
      );
    expect(canDescribe('RestHandler')).toBe(true);
    expect(canDescribe('McpHandler')).toBe(true);
  });

  it('expires only fully ingested raw inbound MIME after the retention window', () => {
    const template = synth(makeConfig());
    // Exactly two rules. Raw inbound: inbound/ AND the ingested tag — untagged raw MIME
    // (dead-lettered mail — the only copy) is kept. Uploads: never-sent ones are swept a day
    // later (a sent one was copied to attachments/sent/*). Bodies, attachments, and the sent
    // archive are permanent.
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'ExpireUnsentUploads',
            Prefix: 'uploads/',
            ExpirationInDays: 1,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Status: 'Enabled',
          },
          {
            Id: 'ExpireIngestedInboundRawMime',
            Prefix: 'inbound/',
            TagFilters: [{ Key: INBOUND_INGESTED_TAG.key, Value: INBOUND_INGESTED_TAG.value }],
            ExpirationInDays: INBOUND_RAW_RETENTION_DAYS,
            Status: 'Enabled',
          },
        ],
      },
    });
    expect(INBOUND_RAW_RETENTION_DAYS).toBe(14);
  });

  it('lets only the app origin PUT uploads straight to the mail bucket (CORS)', () => {
    synth(makeConfig()).hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedMethods: ['PUT'],
            AllowedOrigins: ['https://app.example.com'],
            AllowedHeaders: ['content-type'],
            ExposedHeaders: ['etag'],
            MaxAge: 3000,
          },
        ],
      },
    });
  });

  it('lets the parser look up download tokens (GetItem only) by the same link base REST mints', () => {
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const envOf = (description: string): Record<string, unknown> =>
      functions.find((f) => f.Properties.Description === description)?.Properties.Environment
        .Variables;
    const parserEnv = envOf(
      'FreeMail inbound MIME parser (S3 raw MIME → DDB index + attachments to S3).',
    );
    const restEnv = envOf('FreeMail REST API (auth + app routes).');
    // Links are recognized exactly as they are built.
    expect(parserEnv.DOWNLOAD_BASE_URL).toEqual(restEnv.DOWNLOAD_BASE_URL);
    expect(JSON.stringify(parserEnv.DOWNLOAD_TOKENS_TABLE)).toContain('DataDownloadTokensTable');

    // Every grant the parser holds on the tokens table is a plain read — never a claim
    // (UpdateItem), a write, or a scan.
    const tokenActions = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes('ParserFn'))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[])
      .filter((statement) => JSON.stringify(statement.Resource).includes('DownloadTokensTable'))
      .flatMap((statement) => ([] as unknown[]).concat(statement.Action));
    expect(tokenActions).toEqual(['dynamodb:GetItem']);
  });

  it('gives a send-only deploy no parser to wire', () => {
    const template = synth(makeConfig());
    const parsers = Object.values(template.findResources('AWS::Lambda::Function')).filter((f) =>
      String(f.Properties.Description).startsWith('FreeMail inbound MIME parser'),
    );
    expect(parsers).toHaveLength(0);
  });

  it('lets the inbound parser tag the raw MIME it has fully ingested', () => {
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    expect(canOnMailPrefix(template, 'ParserFn', 's3:PutObjectTagging', '*')).toBe(true);
  });

  it('wires the quarantine bucket: the parser copies in, only REST reads out', () => {
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    const roleCan = (rolePrefix: string, action: string): boolean =>
      Object.values(template.findResources('AWS::IAM::Policy')).some(
        (policy) =>
          JSON.stringify(policy.Properties.Roles).includes(rolePrefix) &&
          (policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]).some(
            (statement) =>
              ([] as unknown[]).concat(statement.Action).includes(action) &&
              JSON.stringify(statement.Resource).includes('QuarantineBucket'),
          ),
      );
    expect(roleCan('ParserFn', 's3:PutObject')).toBe(true);
    expect(roleCan('RestHandler', 's3:GetObject*')).toBe(true);
    // Neither the MCP server nor the REST handler can write into quarantine.
    expect(roleCan('McpHandler', 's3:GetObject*')).toBe(false);
    expect(roleCan('RestHandler', 's3:PutObject')).toBe(false);
    // Both Lambdas that use it are told where it is.
    const envOf = (idPart: string): Record<string, unknown> => {
      const fn = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) =>
        id.includes(idPart),
      );
      return (fn?.[1].Properties.Environment?.Variables ?? {}) as Record<string, unknown>;
    };
    expect(JSON.stringify(envOf('ParserFn').QUARANTINE_BUCKET)).toContain('QuarantineBucket');
    expect(JSON.stringify(envOf('ApiRestHandler').QUARANTINE_BUCKET)).toContain('QuarantineBucket');
  });

  it('lets the send paths write sent bodies and the readers load stored bodies', () => {
    const template = synth(makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }));
    expect(canOnMailPrefix(template, 'RestHandler', 's3:PutObject', 'bodies/sent/*')).toBe(true);
    expect(canOnMailPrefix(template, 'RestHandler', 's3:GetObject*', 'bodies/*')).toBe(true);
    expect(canOnMailPrefix(template, 'McpHandler', 's3:PutObject', 'bodies/sent/*')).toBe(true);
    expect(canOnMailPrefix(template, 'McpHandler', 's3:GetObject*', 'bodies/*')).toBe(true);
    // Negative controls: neither send path may write inbound bodies (only the parser does),
    // and the body grant is put-only — no deletes.
    expect(canOnMailPrefix(template, 'RestHandler', 's3:PutObject', 'bodies/*')).toBe(false);
    expect(canOnMailPrefix(template, 'RestHandler', 's3:DeleteObject*', 'bodies/sent/*')).toBe(
      false,
    );
    expect(canOnMailPrefix(template, 'McpHandler', 's3:DeleteObject*', 'bodies/sent/*')).toBe(
      false,
    );
  });

  it('buckets block public access and enforce SSL', () => {
    const template = synth(makeConfig());
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('wires SES sending: identity for the email domain + config set + bounce/complaint topic', () => {
    const template = synth(makeConfig({ emailDomain: 'mail.example.com' }));
    template.resourceCountIs('AWS::SES::EmailIdentity', 1);
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.example.com',
      MailFromAttributes: { MailFromDomain: 'bounce.mail.example.com' },
    });
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasOutput('SesProductionAccessNote', {});
  });

  it('grants SES send on BOTH the identity and the configuration set', () => {
    // Regression: the sender always passes ConfigurationSetName, and SES authorizes such
    // a send against the config-set resource as well as the identity. Granting only the
    // identity deployed fine and then failed every send at runtime with a 403
    // AccessDeniedException naming the configuration set.
    const template = synth(makeConfig({ emailDomain: 'mail.example.com' }));
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
      (policy.Properties?.PolicyDocument?.Statement ?? []).some(
        (statement: { Action?: unknown }) =>
          Array.isArray(statement.Action) && statement.Action.includes('ses:SendRawEmail'),
      ),
    );
    // Both senders: the REST /emails route and the MCP send_email tool.
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      const statement = policy.Properties.PolicyDocument.Statement.find(
        (candidate: { Action?: unknown }) =>
          Array.isArray(candidate.Action) && candidate.Action.includes('ses:SendRawEmail'),
      );
      expect(statement.Effect).toBe('Allow');
      expect(statement.Action).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
      // Two ARNs, not one — the identity AND the configuration set.
      expect(statement.Resource).toHaveLength(2);
      const rendered = JSON.stringify(statement.Resource);
      expect(rendered).toContain(':identity/mail.example.com');
      expect(rendered).toContain(':configuration-set/');
    }
  });

  it('creates a hosted zone when mode is "create" and outputs name servers', () => {
    const template = synth(makeConfig({ hostedZone: { mode: 'create', zoneName: 'example.com' } }));
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasOutput('HostedZoneNameServers', {});
  });

  it('imports a hosted zone when mode is "import" (no zone resource, no NS output)', () => {
    const template = synth(
      makeConfig({ hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z123' } }),
    );
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    expect(() => template.hasOutput('HostedZoneNameServers', {})).toThrow();
    template.hasOutput('HostedZoneId', {});
  });

  it('does not wire inbound (no receipt rule set / MX) when inbound is disabled', () => {
    const template = synth(makeConfig());
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    template.resourceCountIs('AWS::SES::ReceiptRule', 0);
    // Only the SES sending records exist; no inbound MX on the email domain.
    const mxRecords = Object.values(template.findResources('AWS::Route53::RecordSet')).filter(
      (r) => r.Properties?.Type === 'MX',
    );
    expect(mxRecords.every((r) => r.Properties?.Name !== 'example.com')).toBe(true);
  });

  it('wires inbound (receipt rule set → S3 + inbound MX + activation CR) when enabled', () => {
    const template = synth(
      makeConfig({
        emailDomain: 'mail.example.com',
        inbound: { enabled: true, confirmInboundMx: true },
      }),
    );
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: { Recipients: ['mail.example.com'], ScanEnabled: true },
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'mail.example.com',
      Type: 'MX',
      ResourceRecords: ['10 inbound-smtp.us-east-1.amazonaws.com'],
    });
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('warns at synth when inbound is enabled — MX and active-rule-set takeover', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({ inbound: { enabled: true, confirmInboundMx: true } }),
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasWarning('*', Match.stringLikeRegexp('Inbound email is ENABLED'));
    // The warning must surface the second footgun: FreeMail becoming the region's
    // single active receipt rule set, with a fail-safe deploy on conflict.
    annotations.hasWarning('*', Match.stringLikeRegexp('receipt rule set'));
    annotations.hasWarning('*', Match.stringLikeRegexp('deploy FAILS'));
  });

  it('does not warn when inbound is disabled', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('Inbound email is ENABLED'),
    );
  });

  it('refuses to synth inbound without the MX acknowledgement', () => {
    expect(
      () =>
        new FreeMailStack(new App(), 'TestStack', {
          config: makeConfig({ inbound: { enabled: true, confirmInboundMx: false } }),
        }),
    ).toThrow(/MX override has not been acknowledged/);
  });

  it('warns (does not block) on a CREATED zone — custom domains are now always present', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    const annotations = Annotations.fromStack(stack);
    // Actionable: names the hang and the fix (delegate the zone's name servers).
    annotations.hasWarning(
      '*',
      Match.stringLikeRegexp('Custom domains are configured on a CREATED'),
    );
    annotations.hasWarning('*', Match.stringLikeRegexp('HANG on certificate validation'));
    annotations.hasWarning('*', Match.stringLikeRegexp('name servers'));
  });

  it('warns that inbound still repoints the MX even when the SES identity is imported', () => {
    // Import mode means the domain already has an email setup FreeMail does not own —
    // the likeliest case to have working mail delivery that the MX change would clobber.
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({
        sesIdentity: { mode: 'import' },
        inbound: { enabled: true, confirmInboundMx: true },
      }),
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasWarning('*', Match.stringLikeRegexp('IMPORTED'));
    annotations.hasWarning('*', Match.stringLikeRegexp('dedicated subdomain'));
  });

  it('does NOT warn about the imported identity when it is created by FreeMail', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('is IMPORTED'));
  });

  it('does NOT warn about custom domains on an IMPORTED (already-delegated) zone', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', {
      config: makeConfig({
        hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z123' },
      }),
    });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('Custom domains are configured'),
    );
  });

  it('does NOT warn about custom domains when none are configured', () => {
    const stack = new FreeMailStack(new App(), 'TestStack', { config: makeConfig() });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('custom domain is configured'),
    );
  });

  it('outputs custom URLs + the raw CloudFront domain when app/api domains are set', () => {
    const template = synth(
      makeConfig({ appDomain: 'mail.example.com', apiDomain: 'api.example.com' }),
    );
    template.hasOutput('WebAppUrl', { Value: 'https://mail.example.com' });
    template.hasOutput('WebDistributionDomainName', {});
    template.hasOutput('ApiCustomDomainUrl', { Value: 'https://api.example.com' });
    template.hasOutput('CustomDomainValidationNote', {});
  });

  it('always provisions BOTH custom domains — there is no generated-URL fallback (#47)', () => {
    const template = synth(makeConfig());
    template.hasOutput('WebAppUrl', { Value: 'https://app.example.com' });
    template.hasOutput('ApiCustomDomainUrl', { Value: 'https://api.example.com' });
    template.hasOutput('CustomDomainValidationNote', {});
    // One cert for CloudFront (app) + one for the regional API domain.
    template.resourceCountIs('AWS::CertificateManager::Certificate', 2);
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
  });
});
