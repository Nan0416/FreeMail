/**
 * Run `task` over `items`, at most `limit` at a time. After a failure no further item starts,
 * but the ones already running are waited for before the first error is thrown — so nothing
 * is still in flight once this settles.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await task(item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) {
    throw errors[0];
  }
}
