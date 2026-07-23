import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyRateLimiters, initRateLimiters, RateLimiter } from './rateLimiter.js';

describe('rateLimiter lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyRateLimiters();
  });

  it('destroys existing limiter intervals before reinitializing', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    initRateLimiters();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    initRateLimiters();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  });

  it('expires queued requests by deadline even when no token can become available', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter('zero', {
      maxRequests: 0,
      windowMs: 1_000,
      maxQueueSize: 1,
      queueTimeoutMs: 50,
    });
    const queued = expect(limiter.acquire()).rejects.toThrow(/timed out in queue/);
    await vi.advanceTimersByTimeAsync(101);
    await queued;
    limiter.destroy();
    vi.useRealTimers();
  });
});
