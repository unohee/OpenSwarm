import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyRateLimiters, initRateLimiters } from './rateLimiter.js';

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
});
