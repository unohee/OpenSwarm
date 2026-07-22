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
    const limiter = new RateLimiter('queued', {
      maxRequests: 1,
      windowMs: 10_000,
      maxQueueSize: 1,
      queueTimeoutMs: 50,
    });
    await limiter.acquire();
    const queued = expect(limiter.acquire()).rejects.toThrow(/timed out in queue/);
    await vi.advanceTimersByTimeAsync(101);
    await queued;
    limiter.destroy();
    vi.useRealTimers();
  });

  it.each([
    [{ maxRequests: 0, windowMs: 1000 }, 'maxRequests'],
    [{ maxRequests: 1, windowMs: 0 }, 'windowMs'],
    [{ maxRequests: 1, windowMs: 1000, maxQueueSize: -1 }, 'maxQueueSize'],
    [{ maxRequests: 1, windowMs: 1000, queueTimeoutMs: 0 }, 'queueTimeoutMs'],
  ])('rejects invalid limiter config %j', (config, field) => {
    expect(() => new RateLimiter('invalid', config)).toThrow(field);
  });
});
