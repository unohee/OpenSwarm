import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';

const lifecycle = vi.hoisted(() => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  startHealthChecker: vi.fn(),
  stopHealthChecker: vi.fn(),
  pollers: [] as NodeJS.Timeout[],
  pollersCreated: 0,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, watchFile: lifecycle.watchFile, unwatchFile: lifecycle.unwatchFile };
});

vi.mock('../adapters/processRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/processRegistry.js')>('../adapters/processRegistry.js');
  return {
    ...actual,
    startHealthChecker: lifecycle.startHealthChecker,
    stopHealthChecker: lifecycle.stopHealthChecker,
  };
});

vi.mock('./gitStatus.js', async () => {
  const actual = await vi.importActual<typeof import('./gitStatus.js')>('./gitStatus.js');
  return {
    ...actual,
    startGitStatusPoller: vi.fn(() => {
      const timer = setInterval(() => {}, 60_000);
      timer.unref();
      lifecycle.pollers.push(timer);
      lifecycle.pollersCreated++;
      return timer;
    }),
    stopGitStatusPoller: vi.fn(() => {
      const timer = lifecycle.pollers.pop();
      if (timer) clearInterval(timer);
    }),
  };
});

import { setWebRunner, startWebServer, stopWebServer } from './web.js';

describe('web lifecycle ownership', () => {
  afterEach(async () => {
    await stopWebServer();
    for (const timer of lifecycle.pollers) clearInterval(timer);
    lifecycle.pollers.length = 0;
    lifecycle.pollersCreated = 0;
    vi.clearAllMocks();
  });

  it('releases and recreates watcher, health timer, poller, and server across start-stop-start', async () => {
    const runner = {
      enableProject: vi.fn(),
      disableProject: vi.fn(),
      getEnabledProjects: vi.fn(() => []),
      getAllowedProjects: vi.fn(() => []),
      updateAllowedProjects: vi.fn(),
      registerProjectPath: vi.fn(),
    } as unknown as AutonomousRunner;
    setWebRunner(runner);

    await startWebServer(0);
    await stopWebServer();
    await startWebServer(0);
    await stopWebServer();

    expect(lifecycle.watchFile).toHaveBeenCalledTimes(2);
    expect(lifecycle.unwatchFile).toHaveBeenCalledTimes(2);
    expect(lifecycle.startHealthChecker).toHaveBeenCalledTimes(2);
    expect(lifecycle.stopHealthChecker).toHaveBeenCalledTimes(2);
    expect(lifecycle.pollersCreated).toBe(2);
    expect(lifecycle.pollers).toHaveLength(0);
  });
});
