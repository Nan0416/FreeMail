import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configPath } from '@freemail/shared/config';
import { describe, expect, it, vi } from 'vitest';
import { isEntryPoint, main } from '../src/index.js';

describe('cli', () => {
  it('prints the version', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(main(['version'])).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('freemail'));
    write.mockRestore();
  });

  it('prints help by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(main([])).toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage: freemail'));
    write.mockRestore();
  });

  it('validates the repo-root config, not one in the working directory', () => {
    // Tests run from packages/cli; the message names the file that was checked.
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = main(['validate']);
    const written = [...out.mock.calls, ...err.mock.calls].map(([chunk]) => String(chunk));
    out.mockRestore();
    err.mockRestore();
    expect(written.join('')).toContain(configPath());
    expect(code).toBe(written.some((line) => line.includes('is a valid FreeMail config')) ? 0 : 1);
  });

  it('lists validate in the help', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    main(['help']);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('validate'));
    write.mockRestore();
  });
});

describe('isEntryPoint', () => {
  it('lets `npx freemail` run: the built bin answers through its node_modules/.bin symlink', () => {
    // The built CLI (CI builds before testing), started the way npx starts it.
    const bin = join(dirname(configPath()), 'node_modules', '.bin', 'freemail');
    const result = spawnSync(process.execPath, [bin, 'version'], { encoding: 'utf8' });
    expect(result.stdout).toMatch(/^freemail /);
  });

  it('recognizes the module when node runs it through a symlink, as npx does', () => {
    // Resolved, as node resolves the module's own URL (macOS's tmpdir is itself a symlink).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'freemail-bin-')));
    try {
      const script = join(dir, 'index.js');
      writeFileSync(script, '');
      const bin = join(dir, 'freemail');
      symlinkSync(script, bin);
      const moduleUrl = pathToFileURL(script).href;
      expect(isEntryPoint(bin, moduleUrl)).toBe(true);
      expect(isEntryPoint(script, moduleUrl)).toBe(true);
      expect(isEntryPoint(join(dir, 'other.js'), moduleUrl)).toBe(false);
      expect(isEntryPoint(undefined, moduleUrl)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
