import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the PID file: daemon.ts derives its state dir from homedir() at
// module load, so point homedir at a temp dir BEFORE importing the module.
const TEST_HOME = join(tmpdir(), `osw-daemon-test-home-${process.pid}`);
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// No real sockets: probeDaemonPort goes through global fetch, which each test
// stubs. This keeps the suite runnable in sandboxes that forbid listen().
function stubFetch(impl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const PID_FILE = join(TEST_HOME, '.config', 'openswarm', 'openswarm.pid');

beforeAll(() => {
  mkdirSync(join(TEST_HOME, '.config', 'openswarm'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(PID_FILE, { force: true });
});

describe('probeDaemonPort', () => {
  it('returns true when the daemon API answers 200', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    const fetchFn = stubFetch(async (url) => {
      expect(url).toBe('http://127.0.0.1:3847/api/stats');
      return new Response('{}', { status: 200 });
    });
    expect(await probeDaemonPort()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns false on a non-OK response', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(async () => new Response('', { status: 500 }));
    expect(await probeDaemonPort()).toBe(false);
  });

  it('returns false when the connection is refused', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    expect(await probeDaemonPort()).toBe(false);
  });

  it('returns false when the server hangs past the timeout', async () => {
    const { probeDaemonPort } = await import('./daemon.js');
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
        })
    );
    expect(await probeDaemonPort(3847, 50)).toBe(false);
  });
});

describe('getDaemonStatusFull', () => {
  it('reports an externally managed daemon when the port answers without a PID file', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    stubFetch(async () => new Response('{}', { status: 200 }));
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(true);
    expect(status.external).toBe(true);
  });

  it('reports not running when neither the PID file nor the port shows a daemon', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    stubFetch(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(false);
    expect(status.external).toBeUndefined();
  });

  it('prefers the PID file and skips the port probe when the PID is alive', async () => {
    const { getDaemonStatusFull } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    const fetchFn = stubFetch(async () => new Response('{}', { status: 200 }));
    const status = await getDaemonStatusFull();
    expect(status.running).toBe(true);
    expect(status.external).toBeUndefined();
    expect(status.pid).toBe(process.pid);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('startDaemon duplicate prevention (INT-2473)', () => {
  it('refuses to spawn when the daemon port is already serving (launchd case)', async () => {
    const { startDaemon } = await import('./daemon.js');
    stubFetch(async () => new Response('{}', { status: 200 }));
    await expect(startDaemon()).rejects.toThrow(/already serving port 3847/);
  });

  it('refuses via the PID file without probing when a spawned daemon is alive', async () => {
    const { startDaemon } = await import('./daemon.js');
    writeFileSync(PID_FILE, String(process.pid));
    const fetchFn = stubFetch(async () => new Response('{}', { status: 200 }));
    await expect(startDaemon()).rejects.toThrow(/already running \(pid/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
