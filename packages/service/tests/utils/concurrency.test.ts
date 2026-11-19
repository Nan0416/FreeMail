import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/utils/concurrency.js';

/** A deferred task that records how many are in flight. */
function tracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    get max() {
      return maxInFlight;
    },
    async run<T>(value: T): Promise<T> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    },
  };
}

describe('mapWithConcurrency', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    const t = tracker();
    const items = Array.from({ length: 12 }, (_, i) => i);
    const result = await mapWithConcurrency(items, 5, (item) => t.run(item * 10));
    expect(result).toEqual(items.map((i) => i * 10));
    expect(t.max).toBe(5);
  });

  it('runs everything at once when there are fewer items than the limit', async () => {
    const t = tracker();
    await mapWithConcurrency([1, 2, 3], 5, (item) => t.run(item));
    expect(t.max).toBe(3);
  });

  it('returns an empty array for no items', async () => {
    expect(await mapWithConcurrency([], 5, () => Promise.resolve(1))).toEqual([]);
  });

  it('rejects with the first failure', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, (item) => (item === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(item)))).rejects.toThrow('boom');
  });

  it('refuses a limit below 1', async () => {
    await expect(mapWithConcurrency([1], 0, () => Promise.resolve(1))).rejects.toThrow(/positive integer/);
  });
});
