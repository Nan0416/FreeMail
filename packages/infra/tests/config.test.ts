import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, configPath, loadConfig } from '../src/config.js';

const validConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  // Both required as of #47 — the SPA calls the API cross-origin.
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  inbound: { enabled: false, confirmInboundMx: false },
};

describe('configPath', () => {
  it('resolves to exactly one location: the config file at the repo root', () => {
    // Deliberately not configurable — no CDK context value, no env var, no precedence
    // order to reason about. "Which config did this deploy use?" has one answer.
    const path = configPath();
    expect(path.endsWith(`/${CONFIG_FILENAME}`)).toBe(true);
    expect(CONFIG_FILENAME).toBe('freemail-config.json');
  });

  it('is stable across calls', () => {
    expect(configPath()).toBe(configPath());
  });
});

describe('freemail-config.template.json', () => {
  it('is a valid config — the committed starting point must actually parse', () => {
    // People copy this file and edit it. If the template itself were invalid, the very
    // first `cdk deploy` would fail on a file we shipped.
    const template = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'freemail-config.template.json',
    );
    const config = loadConfig(template);
    expect(config.region).toBe('us-east-1');
    expect(config.appDomain).not.toBe(config.apiDomain);
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
    const file = join(dir, CONFIG_FILENAME);
    writeFileSync(file, JSON.stringify(validConfig));
    expect(loadConfig(file).emailDomain).toBe('example.com');
  });

  it('throws a helpful error when the file is missing', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/freemail init/);
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
