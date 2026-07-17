import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveConfigPath } from './config.js';

const validConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

describe('resolveConfigPath', () => {
  it('prefers context, then env, then the default', () => {
    expect(
      resolveConfigPath({
        contextPath: '/ctx.json',
        envPath: '/env.json',
        defaultPath: '/def.json',
      }),
    ).toBe('/ctx.json');
    expect(
      resolveConfigPath({ contextPath: undefined, envPath: '/env.json', defaultPath: '/def.json' }),
    ).toBe('/env.json');
    expect(
      resolveConfigPath({ contextPath: undefined, envPath: undefined, defaultPath: '/def.json' }),
    ).toBe('/def.json');
  });

  it('ignores non-string context values', () => {
    expect(resolveConfigPath({ contextPath: true, defaultPath: '/def.json' })).toBe('/def.json');
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'freemail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and validates a config file', () => {
    const file = join(dir, 'freemail.config.json');
    writeFileSync(file, JSON.stringify(validConfig));
    expect(loadConfig(file).emailDomain).toBe('example.com');
  });

  it('throws a helpful error when the file is missing', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/Run `freemail init`/);
  });

  it('throws on invalid JSON', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{ not json');
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });

  it('propagates config-validation errors', () => {
    const file = join(dir, 'invalid.json');
    writeFileSync(file, JSON.stringify({ ...validConfig, emailDomain: 'mail.other.com' }));
    expect(() => loadConfig(file)).toThrow(/subdomain/);
  });
});
