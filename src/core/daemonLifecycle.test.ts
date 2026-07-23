import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { cleanupDaemonPid, createShutdownHandler } from './daemonLifecycle.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-daemon-lifecycle-'));
  dirs.push(dir);
  const file = join(dir, 'openswarm.pid');
  writeFileSync(file, '123');
  return file;
}

describe('daemon lifecycle', () => {
  it('removes a daemon PID after startup failure', () => {
    const file = pidFile();
    cleanupDaemonPid(true, file);
    expect(existsSync(file)).toBe(false);
  });

  it('coalesces repeated shutdown signals into one stop and exit', async () => {
    const file = pidFile();
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ isDaemon: true, pidFile: file, stop, exit });

    const first = shutdown('SIGINT');
    const second = shutdown('SIGTERM');
    expect(first).toBe(second);
    expect(stop).toHaveBeenCalledTimes(1);
    release();
    await first;

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(file)).toBe(false);
  });
});
