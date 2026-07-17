import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION,
  isSubdomainOrEqual,
  normalizeDomain,
  parseFreeMailConfig,
} from './config.js';

const base = {
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

describe('isSubdomainOrEqual', () => {
  it('accepts equal and subdomains, rejects unrelated', () => {
    expect(isSubdomainOrEqual('example.com', 'example.com')).toBe(true);
    expect(isSubdomainOrEqual('mail.example.com', 'example.com')).toBe(true);
    expect(isSubdomainOrEqual('notexample.com', 'example.com')).toBe(false);
    expect(isSubdomainOrEqual('example.com.evil.com', 'example.com')).toBe(false);
  });
});

describe('parseFreeMailConfig', () => {
  it('defaults the region to us-east-1', () => {
    expect(parseFreeMailConfig(base).region).toBe(DEFAULT_REGION);
  });

  it('normalizes a valid import config', () => {
    const config = parseFreeMailConfig({
      region: 'us-east-1',
      hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z123' },
      emailDomain: 'mail.example.com',
      appDomain: 'app.example.com',
      inbound: { enabled: true, confirmInboundMx: true },
    });
    expect(config.hostedZone).toEqual({
      mode: 'import',
      zoneName: 'example.com',
      hostedZoneId: 'Z123',
    });
    expect(config.emailDomain).toBe('mail.example.com');
    expect(config.appDomain).toBe('app.example.com');
    expect(config.apiDomain).toBeUndefined();
    expect(config.inbound).toEqual({ enabled: true, confirmInboundMx: true });
  });

  it('requires a hostedZoneId when importing', () => {
    expect(() =>
      parseFreeMailConfig({ ...base, hostedZone: { mode: 'import', zoneName: 'example.com' } }),
    ).toThrow(/hostedZoneId/);
  });

  it('rejects a hostedZoneId when creating', () => {
    expect(() =>
      parseFreeMailConfig({
        ...base,
        hostedZone: { mode: 'create', zoneName: 'example.com', hostedZoneId: 'Z1' },
      }),
    ).toThrow(/only valid when mode is "import"/);
  });

  it('rejects an emailDomain outside the hosted zone', () => {
    expect(() => parseFreeMailConfig({ ...base, emailDomain: 'mail.other.com' })).toThrow(
      /subdomain/,
    );
  });

  it('rejects an invalid hosted-zone mode', () => {
    expect(() =>
      parseFreeMailConfig({ ...base, hostedZone: { mode: 'nope', zoneName: 'example.com' } }),
    ).toThrow(/"import" or "create"/);
  });

  it('rejects a non-boolean inbound flag', () => {
    expect(() =>
      parseFreeMailConfig({ ...base, inbound: { enabled: 'yes', confirmInboundMx: false } }),
    ).toThrow(/must be a boolean/);
  });

  it('rejects a region other than us-east-1', () => {
    expect(() => parseFreeMailConfig({ ...base, region: 'us-west-2' })).toThrow(
      /must be us-east-1/,
    );
  });

  it('canonicalizes domains (case + trailing dot) before validating', () => {
    const config = parseFreeMailConfig({
      ...base,
      hostedZone: { mode: 'create', zoneName: 'Example.COM.' },
      emailDomain: 'MAIL.Example.com.',
      appDomain: 'App.Example.com',
    });
    expect(config.hostedZone.zoneName).toBe('example.com');
    expect(config.emailDomain).toBe('mail.example.com');
    expect(config.appDomain).toBe('app.example.com');
  });

  it('enforces the inbound MX acknowledgement (enabled ⇒ confirmed)', () => {
    expect(() =>
      parseFreeMailConfig({ ...base, inbound: { enabled: true, confirmInboundMx: false } }),
    ).toThrow(/confirmInboundMx/);
    // enabled + confirmed is accepted.
    expect(
      parseFreeMailConfig({ ...base, inbound: { enabled: true, confirmInboundMx: true } }).inbound,
    ).toEqual({ enabled: true, confirmInboundMx: true });
  });

  it('rejects non-object input', () => {
    expect(() => parseFreeMailConfig(null)).toThrow(/expected a JSON object/);
    expect(() => parseFreeMailConfig('nope')).toThrow(/expected a JSON object/);
  });
});

describe('normalizeDomain', () => {
  it('trims, lowercases, and drops a trailing dot', () => {
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com');
    expect(normalizeDomain('mail.example.com')).toBe('mail.example.com');
  });
});
