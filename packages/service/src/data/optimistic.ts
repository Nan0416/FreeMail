/**
 * A small optimistic-concurrency (compare-and-swap) update loop.
 *
 * Read the current value + its version, compute the next value, and write it back
 * only if the version is unchanged; on a conflicting concurrent write, re-read and
 * retry. This turns a non-atomic read-modify-write into a lost-update-free update
 * without a distributed lock — the lockout counter relies on it so parallel failed
 * logins can't overwrite one another and undercount past the threshold.
 */
export interface VersionedValue<T> {
  value: T | null;
  /** 0 when the record does not exist yet. */
  version: number;
}

export async function optimisticUpdate<T>(
  read: () => Promise<VersionedValue<T>>,
  compute: (current: T | null) => T,
  /** Persist `next` iff the stored version still equals `expectedVersion`; false signals a conflict. */
  writeIfVersion: (next: T, expectedVersion: number) => Promise<boolean>,
  maxAttempts = 8,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { value, version } = await read();
    const next = compute(value);
    if (await writeIfVersion(next, version)) {
      return next;
    }
  }
  throw new Error(`optimisticUpdate: gave up after ${maxAttempts} contended attempts`);
}
