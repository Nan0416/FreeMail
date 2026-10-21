import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runValidate, type ValidateIo } from '../src/validate.js';

const validConfig = {
  region: 'us-east-1',
  hostedZone: { mode: 'import', zoneName: 'example.com', hostedZoneId: 'Z0123456ABCDEF' },
  emailDomain: 'mail.example.com',
  appDomain: 'app.example.com',
  apiDomain: 'api.example.com',
  sesIdentity: { mode: 'create' },
  inbound: { enabled: false, confirmInboundMx: false },
};

describe('runValidate', () => {
  let dir: string;
  let io: ValidateIo;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'freemail-validate-'));
    io = { log: vi.fn(), error: vi.fn() };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(contents: string): string {
    const file = join(dir, 'freemail-config.json');
    writeFileSync(file, contents);
    return file;
  }

  it('passes a valid config', () => {
    const file = writeFile(JSON.stringify(validConfig));
    expect(runValidate(io, file)).toBe(0);
    expect(io.log).toHaveBeenCalledWith(`${file} is a valid FreeMail config.`);
    expect(io.error).not.toHaveBeenCalled();
  });

  it('reports every problem at once, so one pass fixes the file', () => {
    const file = writeFile(
      JSON.stringify({
        ...validConfig,
        appDomain: 'app.other.com',
        apiDomain: 'api.other.com',
        inbound: { enabled: true, confirmInboundMx: false },
      }),
    );
    expect(runValidate(io, file)).toBe(1);
    const message = vi.mocked(io.error).mock.calls[0]?.[0];
    expect(message).toMatch(/3 problems/);
    expect(message).toMatch(/appDomain/);
    expect(message).toMatch(/apiDomain/);
    expect(message).toMatch(/confirmInboundMx/);
    expect(io.log).not.toHaveBeenCalled();
  });

  it('fails on invalid JSON', () => {
    const file = writeFile('{ "region": "us-east-1", }');
    expect(runValidate(io, file)).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
  });

  it('fails on a missing file, pointing at freemail init', () => {
    expect(runValidate(io, join(dir, 'freemail-config.json'))).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringMatching(/freemail init/));
  });
});
