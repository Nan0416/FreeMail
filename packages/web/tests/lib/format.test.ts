import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate } from '../../src/lib/format.js';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('guards junk input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  it('falls back to the raw value when unparseable', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });

  it('renders a real timestamp to a non-empty string', () => {
    expect(formatDate('2026-07-17T00:00:00.000Z').length).toBeGreaterThan(0);
  });
});
