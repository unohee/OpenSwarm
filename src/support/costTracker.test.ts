import { describe, it, expect } from 'vitest';
import { formatCost, aggregateCosts, type CostInfo } from './costTracker.js';

const base: CostInfo = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  durationMs: 0,
};

describe('formatCost (INT-2508)', () => {
  it('includes the dollar amount for API-billed runs', () => {
    const s = formatCost({ ...base, costUsd: 0.0432, inputTokens: 1200, outputTokens: 800, durationMs: 12300 });
    expect(s).toBe('$0.0432 | 1.2k in / 800 out | 12.3s');
  });

  it('omits the misleading $0.0000 for subscription-billed runs', () => {
    const s = formatCost({ ...base, inputTokens: 15000, outputTokens: 2000, durationMs: 45200 });
    expect(s).toBe('15.0k in / 2.0k out | 45.2s');
    expect(s).not.toContain('$');
  });

  it('shows cache-read tokens when present', () => {
    const s = formatCost({ ...base, inputTokens: 20000, outputTokens: 1000, cacheReadTokens: 15100, durationMs: 5000 });
    expect(s).toBe('20.0k in / 1.0k out (15.1k cached) | 5.0s');
  });
});

describe('aggregateCosts', () => {
  it('sums fields and skips undefined entries', () => {
    const total = aggregateCosts([
      { ...base, costUsd: 0.01, inputTokens: 100, outputTokens: 10, durationMs: 1000 },
      undefined,
      { ...base, costUsd: 0.02, inputTokens: 200, outputTokens: 20, cacheReadTokens: 50, durationMs: 2000 },
    ]);
    expect(total.costUsd).toBeCloseTo(0.03);
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(30);
    expect(total.cacheReadTokens).toBe(50);
    expect(total.durationMs).toBe(3000);
  });
});
