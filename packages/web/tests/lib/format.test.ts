import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatListDate } from '../../src/lib/format.js';

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

describe('formatListDate', () => {
  const now = new Date(2026, 9, 4, 15, 0);

  it('shows a time for today, a day for this year, a full date otherwise', () => {
    expect(formatListDate(new Date(2026, 9, 4, 9, 5).toISOString(), now)).toMatch(/9:05/);
    expect(formatListDate(new Date(2026, 8, 2, 9, 5).toISOString(), now)).toMatch(/Sep/);
    expect(formatListDate(new Date(2024, 8, 2, 9, 5).toISOString(), now)).toMatch(/24/);
  });

  it('falls back to the raw value when unparseable', () => {
    expect(formatListDate('nope', now)).toBe('nope');
  });
});
