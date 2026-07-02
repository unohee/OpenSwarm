import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => ({
  path: `/tmp/openswarm-scheduler-${process.pid}`,
}));

const spawned = vi.hoisted(() => ({
  processes: [] as Array<EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  }>,
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('os', () => ({
  homedir: () => testHome.path,
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import {
  addSchedule,
  getRecentResults,
  getRunningJobs,
  listSchedules,
  runNow,
  stopAllSchedules,
} from './scheduler.js';

function mockSpawn(closeDelayMs: number | null = 0): void {
  spawnMock.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    spawned.processes.push(proc);
    if (closeDelayMs === null) {
      // Keep the process open until the test emits close.
    } else if (closeDelayMs === 0) {
      queueMicrotask(() => proc.emit('close', 0));
    } else {
      setTimeout(() => proc.emit('close', 0), closeDelayMs);
    }
    return proc;
  });
}

describe('runNow bypass execution', () => {
  beforeEach(async () => {
    stopAllSchedules();
    spawned.processes = [];
    spawnMock.mockReset();
    await rm(testHome.path, { recursive: true, force: true });
  });

  it('uses the scheduled-job path when bypassing the time window', async () => {
    mockSpawn();
    await addSchedule('nightly', testHome.path, 'do work', '0 3 * * *');

    await expect(runNow('nightly', true)).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getRecentResults(1)[0]).toMatchObject({ success: true });
    expect((await listSchedules())[0]).toMatchObject({
      name: 'nightly',
      consecutiveFailures: 0,
    });
    expect((await listSchedules())[0].lastRun).toEqual(expect.any(Number));
  });

  it('does not start a second bypass run for a job that is already running', async () => {
    mockSpawn(null);
    await addSchedule('nightly', testHome.path, 'do work', '0 3 * * *');

    const first = runNow('nightly', true);
    for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(getRunningJobs()).toHaveLength(1);

    await expect(runNow('nightly', true)).resolves.toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawned.processes[0].emit('close', 0);
    await expect(first).resolves.toBe(true);
  });
});
