import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIME_WINDOW, getMarketStatus, isWorkAllowed } from './timeWindow.js';

describe('timeWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the next allowed window start while inside a blocked window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z')); // Mon 09:00 KST

    const result = isWorkAllowed(DEFAULT_TIME_WINDOW);

    expect(result.allowed).toBe(false);
    expect(result.currentTime).toBe('09:00');
    expect(result.nextAllowedTime).toBe('18:30');
  });

  it('treats unrestricted days as market closed and work-allowed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T01:00:00.000Z')); // Sat 10:00 KST

    const status = getMarketStatus(DEFAULT_TIME_WINDOW);

    expect(status.status).toBe('closed');
    expect(status.canWork).toBe(true);
  });

  it('uses current work allowance for market-hours canWork', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T01:00:00.000Z')); // Mon 10:00 KST

    const status = getMarketStatus(DEFAULT_TIME_WINDOW);

    expect(status.status).toBe('regular');
    expect(status.canWork).toBe(false);
  });
});
