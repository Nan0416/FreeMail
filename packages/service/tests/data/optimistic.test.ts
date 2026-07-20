import { describe, expect, it } from 'vitest';
import { optimisticUpdate } from '../../src/data/optimistic.js';

/** In-memory versioned cell mirroring the DynamoDB CAS: a write commits only if the version matches. */
class VersionedCell {
  value: number | null = null;
  version = 0;

  read = (): Promise<{ value: number | null; version: number }> =>
    Promise.resolve({ value: this.value, version: this.version });

  writeIfVersion = (next: number, expectedVersion: number): Promise<boolean> => {
    if (expectedVersion !== this.version) {
      return Promise.resolve(false);
    }
    this.value = next;
    this.version += 1;
    return Promise.resolve(true);
  };
}

describe('optimisticUpdate', () => {
  it('does not lose updates under concurrent increments', async () => {
    const cell = new VersionedCell();
    const increment = () =>
      optimisticUpdate<number>(cell.read, (current) => (current ?? 0) + 1, cell.writeIfVersion);

    // Interleaved at their await points, several of these read the same version and
    // collide — the CAS retries until every increment lands.
    await Promise.all([increment(), increment(), increment(), increment(), increment()]);

    expect(cell.value).toBe(5);
    expect(cell.version).toBe(5);
  });

  it('retries after a version conflict and then commits', async () => {
    let writeAttempts = 0;
    const result = await optimisticUpdate<number>(
      () => Promise.resolve({ value: 41, version: writeAttempts }),
      (current) => (current ?? 0) + 1,
      () => {
        writeAttempts += 1;
        // First write "conflicts", second succeeds.
        return Promise.resolve(writeAttempts >= 2);
      },
    );

    expect(result).toBe(42);
    expect(writeAttempts).toBe(2);
  });

  it('gives up after the retry budget under sustained contention', async () => {
    await expect(
      optimisticUpdate<number>(
        () => Promise.resolve({ value: 0, version: 0 }),
        (current) => (current ?? 0) + 1,
        () => Promise.resolve(false),
        3,
      ),
    ).rejects.toThrow(/contended/);
  });
});
