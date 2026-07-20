import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

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
});
