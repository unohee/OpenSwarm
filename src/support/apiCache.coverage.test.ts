// Purpose: close coverage gaps left by apiCache.test.ts — set()'s overwrite-
// existing-key branch, and the LRU eviction loops for both the cache map
// (evictCacheIfNeeded) and the stats map (evictStatsIfNeeded), none of which
// the existing suite exercises (it never sets a key twice or exceeds the
// default 1000/2000 caps). Uses fresh APICache instances (never the global
// singleton) with a long cleanup interval so the timer never fires mid-test;
// destroy() is called in afterEach to avoid leaking real intervals.
import { describe, it, expect, afterEach } from 'vitest';
import { APICache } from './apiCache.js';

describe('APICache.set overwrite branch', () => {
  let cache: APICache;

  afterEach(() => {
    cache?.destroy();
  });

  it('overwrites an existing key in place instead of growing the cache', () => {
    cache = new APICache(100000);
    cache.set('k1', 'v1', 5000);
    cache.set('k1', 'v2', 5000);
    expect(cache.getSize()).toBe(1);
    expect(cache.get('k1')).toBe('v2');
  });
});

describe('APICache LRU eviction (maxEntries)', () => {
  let cache: APICache;

  afterEach(() => {
    cache?.destroy();
  });

  it('evicts the oldest entry once the cache exceeds maxEntries', () => {
    cache = new APICache(100000, 2, 2000);
    cache.set('a', 1, 5000);
    cache.set('b', 2, 5000);
    cache.set('c', 3, 5000);

    expect(cache.getSize()).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('keeps evicting until back within maxEntries when far over the cap', () => {
    cache = new APICache(100000, 1, 2000);
    cache.set('a', 1, 5000);
    cache.set('b', 2, 5000);
    cache.set('c', 3, 5000);

    expect(cache.getSize()).toBe(1);
    expect(cache.get('c')).toBe(3);
  });
});

describe('APICache stats eviction (maxStats)', () => {
  let cache: APICache;

  afterEach(() => {
    cache?.destroy();
  });

  it('evicts the oldest stats entry once distinct keys exceed maxStats', () => {
    cache = new APICache(100000, 1000, 2);
    cache.get('k1'); // miss -> creates a stats entry for k1
    cache.get('k2'); // miss -> stats size is now 2 (at the cap, no eviction yet)
    cache.get('k3'); // miss -> stats size would be 3, exceeds cap -> evicts k1

    const allStats = cache.getStats() as Record<string, unknown>;
    expect(Object.keys(allStats)).not.toContain('k1');
    expect(Object.keys(allStats)).toEqual(expect.arrayContaining(['k2', 'k3']));
    expect(Object.keys(allStats)).toHaveLength(2);
  });
});
