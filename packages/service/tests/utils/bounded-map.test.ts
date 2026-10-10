import { describe, expect, it } from 'vitest';
import { mapBounded } from '../../src/utils/bounded-map.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapBounded', () => {
  it('keeps results in input order with at most `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapBounded([5, 1, 4, 2, 3, 0], 2, async (n, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return `${index}:${n}`;
    });
    expect(result).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0']);
    expect(peak).toBe(2);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    const gate = deferred();
    const run = mapBounded([0, 1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 0) {
        throw new Error('boom');
      }
      await gate.promise;
      return n;
    });
    await expect(run).rejects.toThrow('boom');
    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1]);
  });

  it('answers an empty list without calling anything', async () => {
    expect(await mapBounded([], 5, () => Promise.reject(new Error('never')))).toEqual([]);
  });
});
