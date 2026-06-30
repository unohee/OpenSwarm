// ============================================
// OpenSwarm - Lightweight concurrency pool (INT-2006)
// ============================================
//
// A minimal "N workers pull from a shared queue" pool for fan-out work that the
// daemon's TaskScheduler can't serve: the scheduler is bound to Linear TaskItem
// + per-project serialization (one worker per repo), which is exactly wrong for
// reviewing ONE repo across MANY areas in parallel. This pool is repo-agnostic,
// one-shot, and settles every item (a thrown worker doesn't abort the batch).

export interface PoolSettled<R> {
  index: number;
  /** Present when the worker resolved. */
  value?: R;
  /** Present when the worker threw — the batch continues regardless. */
  error?: unknown;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Workers pull from a shared cursor, so a slow item never blocks a free worker
 * from starting the next one. Results are returned in input order. `onSettle`
 * fires as each item finishes (any order) for live progress.
 *
 * Never rejects: a worker that throws yields `{ error }` in that slot. Filter on
 * `value`/`error` at the call site.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettle?: (settled: PoolSettled<R>) => void,
): Promise<Array<PoolSettled<R>>> {
  const results: Array<PoolSettled<R>> = Array.from({ length: items.length });
  if (items.length === 0) return results;

  // Clamp: at least 1 worker, never more workers than items.
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let cursor = 0;

  const pump = async (): Promise<void> => {
    // Each worker grabs the next unclaimed index until the queue drains.
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      let settled: PoolSettled<R>;
      try {
        settled = { index, value: await worker(items[index], index) };
      } catch (error) {
        settled = { index, error };
      }
      results[index] = settled;
      onSettle?.(settled);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => pump()));
  return results;
}
