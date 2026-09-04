import { describe, expect, it } from 'vitest';
import { DependencyFactory } from '../../src/dependencies/index.js';
import { InboundDependencyFactory } from '../../src/dependencies/inbound-dependency-factory.js';
import { McpDependencyFactory } from '../../src/dependencies/mcp-dependency-factory.js';
import type { McpConfig } from '../../src/handlers/mcp-config.js';
import type { ServiceConfig } from '../../src/handlers/service-config.js';

const STAGE_CONFIG: ServiceConfig = {
  authTable: 'auth',
  apiKeysTable: 'keys',
  emailsTable: 'emails',
  downloadTokensTable: 'tokens',
  mailBucket: 'bucket',
  emailDomain: 'example.com',
  downloadBaseUrl: 'https://api.example.com',
  sesConfigurationSet: 'cfg',
};

const MCP_CONFIG: McpConfig = {
  emailsTable: 'emails',
  downloadTokensTable: 'tokens',
  mailBucket: 'bucket',
  emailDomain: 'example.com',
  downloadBaseUrl: 'https://api.example.com',
  sesConfigurationSet: undefined,
  inboundEnabled: false,
};

describe('DependencyFactory (REST)', () => {
  it('builds every repo and service from config alone, reading no environment', () => {
    // No process.env is set in this file at all. If the factory still reached for a
    // variable — as the old `create*ServiceFromEnv` layer did — this would throw.
    const deps = new DependencyFactory(STAGE_CONFIG).build();
    for (const [name, value] of Object.entries(deps)) {
      expect(value, `${name} was not built`).toBeDefined();
    }
  });

  it('costs no I/O: the one dependency that needs a table read is injected as a provider', () => {
    // Constructing AuthService would otherwise require the persisted HS256 signing key,
    // putting a DynamoDB read (and a conditional write on a virgin deployment) ahead of the
    // #47 Layer 3 media-type gate. See auth/signing-key-provider.ts.
    const deps = new DependencyFactory(STAGE_CONFIG).build();
    expect(typeof deps.signingKeyProvider.get).toBe('function');
  });

  it('holds no module-scope memoization — each build is independent', () => {
    const a = new DependencyFactory(STAGE_CONFIG).build();
    const b = new DependencyFactory(STAGE_CONFIG).build();
    expect(a.emailsDao).not.toBe(b.emailsDao);
  });
});

describe('McpDependencyFactory', () => {
  it('omits the read service when inbound is disabled', () => {
    const deps = new McpDependencyFactory(MCP_CONFIG).build();
    expect(deps.inboundEnabled).toBe(false);
    // With inbound off the Lambda holds no read grants, so a reader would be an object
    // whose every call is a denied request. Absent is the honest representation.
    expect(deps.readService).toBeUndefined();
    expect(deps.emailService).toBeDefined();
  });

  it('builds the read service when inbound is enabled', () => {
    const deps = new McpDependencyFactory({ ...MCP_CONFIG, inboundEnabled: true }).build();
    expect(deps.inboundEnabled).toBe(true);
    expect(deps.readService).toBeDefined();
  });
});

describe('InboundDependencyFactory', () => {
  it('wires the processor over the store and repo it exposes', () => {
    const deps = new InboundDependencyFactory({
      emailsTable: 'emails',
      mailBucket: 'bucket',
    }).build();
    expect(deps.processor).toBeDefined();
    expect(deps.emailsDao).toBeDefined();
    expect(deps.objectStore).toBeDefined();
  });
});
