import { describe, expect, it } from 'vitest';
import { forEachConcurrently } from '../../src/lib/concurrency.js';

/** A promise the test settles by hand. */
function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('forEachConcurrently', () => {
  it('never runs more than the limit at once, and runs every item', async () => {
    const running = new Map<number, ReturnType<typeof deferred>>();
    const done: number[] = [];
    const all = forEachConcurrently([1, 2, 3, 4, 5], 2, async (item) => {
      const task = deferred();
      running.set(item, task);
      await task.promise;
      running.delete(item);
      done.push(item);
    });

    await flush();
    expect([...running.keys()]).toEqual([1, 2]);
    running.get(2)?.resolve();
    await flush();
    expect([...running.keys()]).toEqual([1, 3]);
    for (const item of [1, 3, 4, 5]) {
      running.get(item)?.resolve();
      await flush();
    }
    await all;
    expect(done).toEqual([2, 1, 3, 4, 5]);
  });

  it('starts nothing new after a failure, waits for the running ones, then throws the first error', async () => {
    const running = new Map<number, ReturnType<typeof deferred>>();
    const started: number[] = [];
    let settled = false;
    const all = forEachConcurrently([1, 2, 3], 2, async (item) => {
      started.push(item);
      const task = deferred();
      running.set(item, task);
      await task.promise;
    }).finally(() => {
      settled = true;
    });
    const outcome = all.catch((error: unknown) => error);

    await flush();
    running.get(1)?.reject(new Error('first'));
    await flush();
    // Item 2 is still running, so the call has not settled, and item 3 never starts.
    expect(settled).toBe(false);
    running.get(2)?.reject(new Error('second'));

    expect(await outcome).toEqual(new Error('first'));
    expect(started).toEqual([1, 2]);
  });

  it('does nothing for no items', async () => {
    await expect(forEachConcurrently([], 4, async () => {})).resolves.toBeUndefined();
  });
});
