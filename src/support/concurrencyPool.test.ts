import { describe, it, expect } from 'vitest';
import { runPool } from './concurrencyPool.js';

describe('runPool (INT-2006)', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1];
    const out = await runPool(delays, 2, async (d, i) => {
      await new Promise((r) => setTimeout(r, d));
      return i * 10;
    });
    expect(out.map((s) => s.value)).toEqual([0, 10, 20, 30]);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it('settles a throwing worker without aborting the batch', async () => {
    const out = await runPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out[0]).toEqual({ index: 0, value: 1 });
    expect(out[1].error).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ index: 2, value: 3 });
  });

  it('processes every item exactly once', async () => {
    const seen = new Set<number>();
    await runPool(Array.from({ length: 50 }, (_, i) => i), 8, async (n) => {
      seen.add(n);
      return n;
    });
    expect(seen.size).toBe(50);
  });

  it('fires onSettle once per item', async () => {
    let count = 0;
    await runPool([1, 2, 3, 4], 2, async (n) => n, () => count++);
    expect(count).toBe(4);
  });

  it('returns empty for empty input', async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });

  it('clamps concurrency below 1 to a single worker', async () => {
    const out = await runPool([1, 2], 0, async (n) => n);
    expect(out.map((s) => s.value)).toEqual([1, 2]);
  });
});
