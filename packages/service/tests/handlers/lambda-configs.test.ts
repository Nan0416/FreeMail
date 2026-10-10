import { describe, expect, it } from 'vitest';
import { getAuthorizerConfig } from '../../src/handlers/authorizer-config.js';
import { getInboundConfig } from '../../src/handlers/inbound-config.js';
import { getMcpConfig } from '../../src/handlers/mcp-config.js';

const MCP_ENV: NodeJS.ProcessEnv = {
  EMAILS_TABLE: 'emails',
  DOWNLOAD_TOKENS_TABLE: 'tokens',
  MAIL_BUCKET: 'bucket',
  EMAIL_DOMAIN: 'example.com',
  DOWNLOAD_BASE_URL: 'https://api.example.com',
};

describe('per-Lambda configs are narrow', () => {
  it('the MCP handler needs no AUTH_TABLE or API_KEYS_TABLE', () => {
    // Authentication is the authorizer's job, and an agent must never reach key management,
    // so CDK gives the MCP function neither table. A shared config would demand both.
    expect(() => getMcpConfig(MCP_ENV)).not.toThrow();
  });

  it('the inbound handler needs only the emails table, the mail bucket, and quarantine', () => {
    expect(
      getInboundConfig({ EMAILS_TABLE: 'emails', MAIL_BUCKET: 'bucket', QUARANTINE_BUCKET: 'q' }),
    ).toEqual({
      emailsTable: 'emails',
      mailBucket: 'bucket',
      quarantineBucket: 'q',
    });
  });

  it('the authorizer needs only its two read-only tables', () => {
    expect(getAuthorizerConfig({ AUTH_TABLE: 'auth', API_KEYS_TABLE: 'keys' })).toEqual({
      authTable: 'auth',
      apiKeysTable: 'keys',
    });
  });
});

describe('INBOUND_ENABLED is fail-closed', () => {
  it.each([undefined, '', 'TRUE', 'True', '1', 'yes', 'false'])(
    'treats %o as disabled — only the exact string "true" enables the read tools',
    (value) => {
      const env = value === undefined ? MCP_ENV : { ...MCP_ENV, INBOUND_ENABLED: value };
      expect(getMcpConfig(env).inboundEnabled).toBe(false);
    },
  );

  it('enables on exactly "true"', () => {
    expect(getMcpConfig({ ...MCP_ENV, INBOUND_ENABLED: 'true' }).inboundEnabled).toBe(true);
  });
});

describe('config validation names every missing variable at once', () => {
  it('reports all of them in one error, not just the first', () => {
    expect(() => getMcpConfig({ EMAILS_TABLE: 'emails' })).toThrow(
      /DOWNLOAD_BASE_URL, DOWNLOAD_TOKENS_TABLE, EMAIL_DOMAIN, MAIL_BUCKET/,
    );
  });

  it('names the component so the failing Lambda is obvious in the logs', () => {
    expect(() => getInboundConfig({})).toThrow(/FreeMail inbound handler is misconfigured/);
  });
});
