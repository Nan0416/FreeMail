import { describe, expect, it } from 'vitest';
import { DEFAULT_REGION, parseFreeMailConfig } from '../src/config.js';

const base = {
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  // Both custom domains are REQUIRED as of #47 — the browser calls the API cross-origin.
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

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
      apiDomain: 'api.example.com',
      inbound: { enabled: true, confirmInboundMx: true },
    });
    expect(config.hostedZone).toEqual({
      mode: 'import',
      zoneName: 'example.com',
      hostedZoneId: 'Z123',
    });
    expect(config.emailDomain).toBe('mail.example.com');
    expect(config.appDomain).toBe('app.example.com');
    expect(config.apiDomain).toBe('api.example.com');
    expect(config.inbound).toEqual({ enabled: true, confirmInboundMx: true });
  });

  /** `base` minus one key — the shapes a pre-#47 config file would have. */
  function without(key: 'appDomain' | 'apiDomain'): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...base };
    delete copy[key];
    return copy;
  }

  it('requires appDomain — a deploy without it has no working web app (#47)', () => {
    expect(() => parseFreeMailConfig(without('appDomain'))).toThrow(/appDomain/);
  });

  it('requires apiDomain — the browser and agents both reach the API there (#47)', () => {
    expect(() => parseFreeMailConfig(without('apiDomain'))).toThrow(/apiDomain/);
  });

  it('rejects one domain without the other', () => {
    expect(() => parseFreeMailConfig(without('apiDomain'))).toThrow(/apiDomain/);
    expect(() => parseFreeMailConfig(without('appDomain'))).toThrow(/appDomain/);
  });

  it('still rejects an app and api domain that are the same host', () => {
    // They would collide as alias records, and it would collapse the cross-origin
    // boundary the #47 CORS model depends on.
    expect(() =>
      parseFreeMailConfig({ ...base, appDomain: 'x.example.com', apiDomain: 'x.example.com' }),
    ).toThrow(/must be different domains/);
  });

  it('reports EVERY problem at once, not just the first', () => {
    // The hand-rolled parser this replaced threw on the first bad field, so fixing a
    // config was a guess-and-retry loop. zod collects them in one pass.
    let message = '';
    try {
      parseFreeMailConfig({
        ...base,
        emailDomain: 'mail.other.com',
        appDomain: 'app.other.com',
        apiDomain: 'api.other.com',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('3 problems');
    expect(message).toContain('emailDomain');
    expect(message).toContain('appDomain');
    expect(message).toContain('apiDomain');
  });

  it('defaults sesIdentity to create when omitted', () => {
    // A config written before this option existed must keep deploying identically.
    expect(parseFreeMailConfig(base).sesIdentity).toEqual({ mode: 'create' });
  });

  it('accepts sesIdentity import for a domain already set up for SES', () => {
    const config = parseFreeMailConfig({ ...base, sesIdentity: { mode: 'import' } });
    expect(config.sesIdentity.mode).toBe('import');
  });

  it('rejects an unknown sesIdentity mode', () => {
    expect(() => parseFreeMailConfig({ ...base, sesIdentity: { mode: 'adopt' } })).toThrow(
      /"create" or "import"/,
    );
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

  it('accepts app/api custom domains inside the hosted zone', () => {
    const config = parseFreeMailConfig({
      ...base,
      appDomain: 'mail.example.com',
      apiDomain: 'api.example.com',
    });
    expect(config.appDomain).toBe('mail.example.com');
    expect(config.apiDomain).toBe('api.example.com');
  });

  it('rejects an appDomain outside the hosted zone', () => {
    expect(() => parseFreeMailConfig({ ...base, appDomain: 'app.other.com' })).toThrow(
      /"appDomain".*subdomain/,
    );
  });

  it('rejects an apiDomain outside the hosted zone', () => {
    expect(() => parseFreeMailConfig({ ...base, apiDomain: 'api.other.com' })).toThrow(
      /"apiDomain".*subdomain/,
    );
  });

  it('rejects appDomain and apiDomain being the same host', () => {
    expect(() =>
      parseFreeMailConfig({
        ...base,
        appDomain: 'mail.example.com',
        apiDomain: 'Mail.example.com',
      }),
    ).toThrow(/must be different domains/);
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

describe('parseFreeMailConfig — attachments', () => {
  it('omits attachments when not configured (the defaults apply)', () => {
    expect(parseFreeMailConfig(base).attachments).toBeUndefined();
  });

  it('accepts embed limits within their caps', () => {
    expect(
      parseFreeMailConfig({
        ...base,
        attachments: { embedMaxBytes: 5 * 1024 * 1024, embedTotalBytes: 12 * 1024 * 1024 },
      }).attachments,
    ).toEqual({ embedMaxBytes: 5 * 1024 * 1024, embedTotalBytes: 12 * 1024 * 1024 });
  });

  it('rejects an embed limit past its cap, or not a whole number', () => {
    expect(() =>
      parseFreeMailConfig({ ...base, attachments: { embedMaxBytes: 16 * 1024 * 1024 } }),
    ).toThrow(/at most 15 MB/);
    expect(() =>
      parseFreeMailConfig({ ...base, attachments: { embedTotalBytes: 21 * 1024 * 1024 } }),
    ).toThrow(/at most 20 MB/);
    expect(() => parseFreeMailConfig({ ...base, attachments: { embedMaxBytes: 1.5 } })).toThrow(
      /whole number/,
    );
  });
});
