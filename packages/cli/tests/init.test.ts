import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseFreeMailConfig } from '@freemail/shared/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_FILENAME,
  buildConfig,
  runInit,
  writeConfig,
  type InitAnswers,
  type InitIo,
} from '../src/init.js';

const answers = (overrides: Partial<InitAnswers> = {}): InitAnswers => ({
  hostedZone: { mode: 'create', zoneName: 'example.com' },
  emailDomain: 'example.com',
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  sesIdentityExists: false,
  inboundEnabled: false,
  inboundConfirmed: false,
  ...overrides,
});

describe('buildConfig', () => {
  it('produces a valid config for the base case', () => {
    const config = buildConfig(answers());
    expect(config.region).toBe('us-east-1');
    expect(config.inbound).toEqual({ enabled: false, confirmInboundMx: false });
    // Both domains are required as of #47 and flow straight through.
    expect(config.appDomain).toBe('app.example.com');
    expect(config.apiDomain).toBe('api.example.com');
  });

  it('rejects answers missing a domain — the parser is the single gate (#47)', () => {
    const withoutApp: Record<string, unknown> = { ...answers() };
    delete withoutApp.appDomain;
    expect(() => buildConfig(withoutApp as never)).toThrow(/appDomain/);
  });

  it('maps an existing SES identity to import mode', () => {
    expect(buildConfig(answers()).sesIdentity).toEqual({ mode: 'create' });
    expect(buildConfig(answers({ sesIdentityExists: true })).sesIdentity).toEqual({
      mode: 'import',
    });
  });

  it('enables inbound only when acknowledged', () => {
    expect(buildConfig(answers({ inboundEnabled: true, inboundConfirmed: true })).inbound).toEqual({
      enabled: true,
      confirmInboundMx: true,
    });
    // Enabled but not confirmed → inbound stays off (and un-acknowledged).
    expect(buildConfig(answers({ inboundEnabled: true, inboundConfirmed: false })).inbound).toEqual(
      {
        enabled: false,
        confirmInboundMx: false,
      },
    );
  });

  it('carries optional domains and the imported zone id', () => {
    const config = buildConfig(
      answers({
        hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z9' },
        emailDomain: 'mail.example.com',
        appDomain: 'app.example.com',
        apiDomain: 'api.example.com',
      }),
    );
    expect(config.hostedZone).toEqual({
      mode: 'import',
      zoneName: 'example.com',
      hostedZoneId: 'Z9',
    });
    expect(config.appDomain).toBe('app.example.com');
    expect(config.apiDomain).toBe('api.example.com');
  });

  it('rejects an email domain outside the zone', () => {
    expect(() => buildConfig(answers({ emailDomain: 'mail.other.com' }))).toThrow(/subdomain/);
  });
});

describe('writeConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'freemail-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes pretty JSON that round-trips through the parser', async () => {
    const file = join(dir, 'freemail-config.json');
    const config = buildConfig(answers());
    await writeConfig(file, config);
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(parseFreeMailConfig(JSON.parse(raw))).toEqual(config);
  });
});

describe('runInit', () => {
  function fakeIo(overrides: Partial<InitIo> = {}): InitIo {
    return {
      prompt: vi.fn(async () => answers()),
      fileExists: vi.fn(() => false),
      confirmOverwrite: vi.fn(async () => true),
      write: vi.fn(async () => {}),
      log: vi.fn(),
      ...overrides,
    };
  }

  it('always writes to the one config path the CDK app reads', async () => {
    const io = fakeIo();
    const code = await runInit(io);
    expect(code).toBe(0);
    // Fixed location, no --out override: anywhere else and `cdk deploy` would not find it.
    expect(io.write).toHaveBeenCalledWith(
      resolve(CONFIG_FILENAME),
      expect.objectContaining({ region: 'us-east-1' }),
    );
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('Next steps'));
  });

  it('aborts without writing when overwrite is declined', async () => {
    const io = fakeIo({
      fileExists: vi.fn(() => true),
      confirmOverwrite: vi.fn(async () => false),
    });
    const code = await runInit(io);
    expect(code).toBe(1);
    expect(io.write).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
  });

  it('overwrites when confirmed', async () => {
    const io = fakeIo({ fileExists: vi.fn(() => true), confirmOverwrite: vi.fn(async () => true) });
    expect(await runInit(io)).toBe(0);
    expect(io.write).toHaveBeenCalledTimes(1);
  });
});
