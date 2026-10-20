import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('lists validate in the help', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    main(['help']);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('validate'));
    write.mockRestore();
  });
});

describe('isEntryPoint', () => {
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
