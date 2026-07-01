import { describe, it, expect, vi } from 'vitest';
import { isNewer, shouldSkip, maybeNotifyUpdate } from './updateNotifier.js';

describe('isNewer (INT-2270)', () => {
  it('compares semver numerically', () => {
    expect(isNewer('0.13.0', '0.12.0')).toBe(true);
    expect(isNewer('0.12.1', '0.12.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.12.0', '0.12.0')).toBe(false);
    expect(isNewer('0.11.9', '0.12.0')).toBe(false);
  });
  it('ignores pre-release tags', () => {
    expect(isNewer('0.13.0-beta.1', '0.13.0')).toBe(false);
  });
});

describe('shouldSkip (INT-2270)', () => {
  const tty = true;
  it('skips non-TTY, CI, opt-out, and meta commands', () => {
    expect(shouldSkip(['n', 'c', 'run'], {}, false)).toBe(true); // non-TTY
    expect(shouldSkip(['n', 'c', 'run'], { CI: '1' }, tty)).toBe(true);
    expect(shouldSkip(['n', 'c', 'run'], { NO_UPDATE_NOTIFIER: '1' }, tty)).toBe(true);
    expect(shouldSkip(['n', 'c', '--version'], {}, tty)).toBe(true);
    expect(shouldSkip(['n', 'c', 'review', '--help'], {}, tty)).toBe(true);
  });
  it('does not skip a normal interactive command', () => {
    expect(shouldSkip(['n', 'c', 'run', 'do a thing'], {}, tty)).toBe(false);
    expect(shouldSkip(['n', 'c'], {}, tty)).toBe(false); // default TUI
  });
});

describe('maybeNotifyUpdate (INT-2270)', () => {
  const base = { argv: ['n', 'c', 'run'], env: {} as NodeJS.ProcessEnv, isTTY: true };

  it('notifies from a fresh cache without fetching', async () => {
    const write = vi.fn();
    const fetchLatest = vi.fn();
    await maybeNotifyUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1000 + 60_000, // 1 min later — fresh
      fetchLatest,
      write,
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('0.13.0');
  });

  it('fetches when the cache is stale, writes it, and notifies', async () => {
    const write = vi.fn();
    const writeCache = vi.fn();
    await maybeNotifyUpdate('0.12.0', {
      ...base,
      readCache: () => ({ latest: '0.12.0', checkedAt: 0 }),
      now: () => 999_999_999, // far future — stale
      fetchLatest: async () => '0.13.0',
      writeCache,
      write,
    });
    expect(writeCache).toHaveBeenCalledWith({ latest: '0.13.0', checkedAt: 999_999_999 });
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not notify when already on the latest', async () => {
    const write = vi.fn();
    await maybeNotifyUpdate('0.13.0', {
      ...base,
      readCache: () => ({ latest: '0.13.0', checkedAt: 1000 }),
      now: () => 1001,
      write,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('backs off (stamps the cache) when the fetch fails', async () => {
    const writeCache = vi.fn();
    const write = vi.fn();
    await maybeNotifyUpdate('0.12.0', {
      ...base,
      readCache: () => null,
      now: () => 5000,
      fetchLatest: async () => null, // registry error
      writeCache,
      write,
    });
    expect(writeCache).toHaveBeenCalledWith({ latest: '0.12.0', checkedAt: 5000 });
    expect(write).not.toHaveBeenCalled();
  });

  it('is a no-op when skipped (non-TTY)', async () => {
    const fetchLatest = vi.fn();
    const write = vi.fn();
    await maybeNotifyUpdate('0.12.0', { ...base, isTTY: false, fetchLatest, write });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
