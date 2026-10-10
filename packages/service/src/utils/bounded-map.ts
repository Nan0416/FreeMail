/**
 * Map over `items` with at most `limit` calls in flight, results in input order. The first
 * rejection rejects the map and stops new calls from starting (ones already running finish).
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
