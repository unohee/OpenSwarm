// ============================================
// OpenSwarm - Scheduler Coverage Tests
// ============================================
//
// Companion to scheduler.test.ts (the pure `nextFailureState` helper) and
// scheduler.runNow.test.ts (bypass-execution smoke tests). This file targets
// the branches those two don't reach: the private runClaudeCli buffer
// bounding / watchdog timeout / spawn-error handling, removeSchedule /
// toggleSchedule / startAllSchedules / stopAllSchedules, the auto-pause
// path, the time-window-blocked path, invalid cron expressions, the
// intervalToCron shorthand conversion, and the two pure formatting helpers
// (formatScheduleList, parseScheduleFromNaturalLanguage).
//
// Same mocking convention as scheduler.runNow.test.ts: `os.homedir` and
// `child_process.spawn` are mocked so nothing here touches the real
// `~/.openswarm/schedules.json` or spawns a real `claude` process.

import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDateLocale, t } from '../locale/index.js';
import { getTimeWindowConfig, setTimeWindowConfig } from '../support/timeWindow.js';

const testHome = vi.hoisted(() => ({
  path: `/tmp/openswarm-scheduler-coverage-${process.pid}`,
}));

const spawned = vi.hoisted(() => ({
  processes: [] as Array<
    EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    }
  >,
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
  formatScheduleList,
  getRecentResults,
  getRunningJobs,
  listSchedules,
  MAX_CONSECUTIVE_FAILURES,
  parseScheduleFromNaturalLanguage,
  removeSchedule,
  runNow,
  setResultListener,
  startAllSchedules,
  stopAllSchedules,
  toggleSchedule,
  type ScheduledJob,
} from './scheduler.js';

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockProc(): MockProc {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) as MockProc;
  spawned.processes.push(proc);
  return proc;
}

/** Queue a spawn that closes with the given exit code on the next microtask. */
function queueSpawnClosingWith(code: number): void {
  spawnMock.mockImplementationOnce(() => {
    const proc = createMockProc();
    queueMicrotask(() => proc.emit('close', code));
    return proc;
  });
}

describe('scheduler coverage', () => {
  let savedTimeWindowConfig: ReturnType<typeof getTimeWindowConfig>;

  beforeEach(async () => {
    stopAllSchedules();
    spawned.processes = [];
    spawnMock.mockReset();
    await rm(testHome.path, { recursive: true, force: true });
    savedTimeWindowConfig = getTimeWindowConfig();
    setResultListener(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setTimeWindowConfig(savedTimeWindowConfig);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================
  // Pure helpers: formatScheduleList
  // ==========================================================

  describe('formatScheduleList', () => {
    it('reports no schedules when the list is empty', () => {
      expect(formatScheduleList([])).toBe(t('service.scheduler.noSchedules'));
    });

    it('formats enabled and disabled jobs with distinct status glyphs and last-run labels', () => {
      const enabledJob: ScheduledJob = {
        id: 'job-1',
        name: 'nightly-build',
        projectPath: '~/dev/app',
        prompt: 'run build',
        schedule: '0 3 * * *',
        enabled: true,
        createdAt: 1720000000000,
      };
      const disabledJob: ScheduledJob = {
        id: 'job-2',
        name: 'paused-job',
        projectPath: '~/dev/other',
        prompt: 'run tests',
        schedule: '0 4 * * *',
        enabled: false,
        createdAt: 1720000000000,
        lastRun: 1720000500000,
      };

      const output = formatScheduleList([enabledJob, disabledJob]);
      const entries = output.split('\n\n');

      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('✅');
      expect(entries[0]).toContain('nightly-build');
      expect(entries[0]).toContain(t('common.fallback.none'));
      expect(entries[1]).toContain('⏸️');
      expect(entries[1]).toContain('paused-job');
      expect(entries[1]).toContain(new Date(disabledJob.lastRun!).toLocaleString(getDateLocale()));
    });
  });

  // ==========================================================
  // Pure helpers: parseScheduleFromNaturalLanguage
  // ==========================================================

  describe('parseScheduleFromNaturalLanguage', () => {
    it('returns null when nothing can be extracted', () => {
      expect(parseScheduleFromNaturalLanguage('')).toBeNull();
    });

    it('extracts a quoted name and a minute interval', () => {
      expect(parseScheduleFromNaturalLanguage('"nightly build" every 30 min')).toEqual({
        name: 'nightly build',
        schedule: '30m',
      });
    });

    it('extracts an unquoted first token as the name', () => {
      const result = parseScheduleFromNaturalLanguage('nightly run every 2h');
      expect(result?.name).toBe('nightly');
      expect(result?.schedule).toBe('2h');
    });

    it('maps the "hour" and "h" unit spellings to the h suffix', () => {
      expect(parseScheduleFromNaturalLanguage('job every 1 hour')?.schedule).toBe('1h');
      expect(parseScheduleFromNaturalLanguage('job every 4h')?.schedule).toBe('4h');
    });

    it('keeps the d unit as-is', () => {
      expect(parseScheduleFromNaturalLanguage('job every 3d')?.schedule).toBe('3d');
    });

    it('overrides the schedule with a fixed daily cron expression', () => {
      expect(parseScheduleFromNaturalLanguage('job daily')?.schedule).toBe('0 9 * * *');
    });

    it('overrides the schedule with a fixed weekly cron expression', () => {
      expect(parseScheduleFromNaturalLanguage('job weekly')?.schedule).toBe('0 9 * * 1');
    });
  });

  // ==========================================================
  // intervalToCron (private) — exercised indirectly via addSchedule,
  // observed through the "Started cron for ..." log line.
  // ==========================================================

  describe('interval shorthand conversion (via addSchedule)', () => {
    it.each([
      ['5m', '*/5 * * * *'],
      ['1h', '0 * * * *'],
      ['3h', '0 */3 * * *'],
      ['2d', '0 9 */2 * *'],
    ])('converts "%s" into the cron expression "%s"', async (interval, expectedCron) => {
      const job = await addSchedule(`interval-${interval}`, testHome.path, 'do work', interval);

      expect(job.schedule).toBe(interval); // stored verbatim; conversion happens only when the cron starts
      expect(
        vi
          .mocked(console.log)
          .mock.calls.some(
            ([msg]) => typeof msg === 'string' && msg.includes(`Started cron for ${job.name}: ${expectedCron}`),
          ),
      ).toBe(true);
    });

    it('logs and swallows an error for an invalid cron expression instead of throwing', async () => {
      await expect(
        addSchedule('bad-cron-job', testHome.path, 'do work', 'not a valid cron at all'),
      ).resolves.toBeTruthy();

      expect(
        vi
          .mocked(console.error)
          .mock.calls.some(
            ([msg]) => typeof msg === 'string' && msg.includes('Failed to start cron for bad-cron-job'),
          ),
      ).toBe(true);
      // The schedule is still persisted even though its cron never started.
      expect((await listSchedules()).find((s) => s.name === 'bad-cron-job')).toBeTruthy();
    });
  });

  // ==========================================================
  // addSchedule — duplicate name guard
  // ==========================================================

  it('rejects adding a schedule whose name already exists', async () => {
    await addSchedule('dup-job', testHome.path, 'do work', '0 3 * * *');
    await expect(addSchedule('dup-job', testHome.path, 'do work', '0 4 * * *')).rejects.toThrow(
      'already exists',
    );
  });

  // ==========================================================
  // runClaudeCli (private) — exercised via runNow/runScheduledJob.
  // ==========================================================

  describe('claude CLI process handling', () => {
    it('extracts the cost log and the parsed result text from a stream-json result event', async () => {
      spawnMock.mockImplementationOnce(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                type: 'result',
                result: 'Build succeeded.',
                total_cost_usd: 0.031,
                usage: { input_tokens: 120, output_tokens: 40 },
              })}\n`,
            ),
          );
          proc.emit('close', 0);
        });
        return proc;
      });

      await addSchedule('cost-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('cost-job', true)).resolves.toBe(true);

      const result = getRecentResults(1)[0];
      expect(result.output).toBe('Build succeeded.');
      expect(
        vi.mocked(console.log).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('cost:')),
      ).toBe(true);
    });

    it('resolves as a failure when the spawned process emits an error event', async () => {
      spawnMock.mockImplementationOnce(() => {
        const proc = createMockProc();
        queueMicrotask(() => proc.emit('error', new Error('ENOENT: claude not found')));
        return proc;
      });

      await addSchedule('spawn-error-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('spawn-error-job', true)).resolves.toBe(false);

      const result = getRecentResults(1)[0];
      expect(result.success).toBe(false);
      expect(result.error).toBe('ENOENT: claude not found');
      expect(result.output).toBe('');
    });

    it('bounds the stderr buffer instead of growing it unbounded', async () => {
      const MAX_CLI_BUFFER_CHARS = 128 * 1024; // mirrors the private constant in scheduler.ts

      spawnMock.mockImplementationOnce(() => {
        const proc = createMockProc();
        queueMicrotask(() => {
          proc.stderr.emit('data', Buffer.from('a'.repeat(140_000)));
          proc.stderr.emit('data', Buffer.from('MARKERZZZ'));
          proc.emit('close', 1);
        });
        return proc;
      });

      await addSchedule('big-stderr-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('big-stderr-job', true)).resolves.toBe(false);

      const result = getRecentResults(1)[0];
      const err = result.error as string;
      expect(err).toBeDefined();
      expect(err).toHaveLength(MAX_CLI_BUFFER_CHARS);
      expect(err.endsWith('MARKERZZZ')).toBe(true);
      expect(err.startsWith('a')).toBe(true);
    });

    it('kills a hung process and fails the job once the watchdog timeout elapses', async () => {
      // Scope fake timers to setTimeout/clearTimeout only — faking Date/setImmediate
      // as well interferes with Croner's real internal scheduling and Node's fs
      // promise resolution, which previously hung this test indefinitely.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let proc!: MockProc;
      spawnMock.mockImplementationOnce(() => {
        proc = createMockProc(); // never closes on its own — simulates a hang
        return proc;
      });

      await addSchedule('hung-job', testHome.path, 'do work', '0 3 * * *');
      const pending = runNow('hung-job', true);

      // Wait (via real timers — not faked) for the spawn + watchdog
      // registration to actually happen before advancing the fake clock.
      // Both are synchronous back-to-back statements in runClaudeCli, so
      // once the process shows up as running the watchdog is armed too.
      // Advancing before this point races the still-in-flight real fs I/O
      // (loadSchedules/saveSchedules) and can register the timer relative to
      // an already-advanced clock, so it never fires within this call.
      // `vi.waitFor` (not a fixed-count setImmediate loop) so this doesn't
      // flake under CI/parallel-worker CPU contention that slows the real
      // fs I/O below whatever iteration budget a hard-coded loop assumed.
      await vi.waitFor(
        () => {
          expect(getRunningJobs()).toHaveLength(1);
        },
        { timeout: 5000, interval: 10 },
      );

      await vi.advanceTimersByTimeAsync(20 * 60_000); // mirrors CRON_JOB_TIMEOUT_MS

      await expect(pending).resolves.toBe(false);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

      const result = getRecentResults(1)[0];
      expect(result.error).toContain('timed out');
    });
  });

  // ==========================================================
  // runScheduledJob — time window, listener, and auto-pause branches.
  // ==========================================================

  describe('runScheduledJob', () => {
    it('skips the run and returns false when the time window blocks work (default runNow path)', async () => {
      setTimeWindowConfig({
        enabled: true,
        restrictedDays: [], // empty (not just falsy) — the blockedWindows check always applies
        blockedWindows: [{ start: '00:00', end: '23:59' }],
        allowedWindows: [],
      });

      await addSchedule('blocked-job', testHome.path, 'do work', '0 3 * * *');
      // No bypass argument here — exercises runNow's default (non-bypass) path.
      await expect(runNow('blocked-job')).resolves.toBe(false);

      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('notifies the registered result listener on completion', async () => {
      const listener = vi.fn();
      setResultListener(listener);
      queueSpawnClosingWith(0);

      await addSchedule('listener-job', testHome.path, 'do work', '0 3 * * *');
      await runNow('listener-job', true);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toMatchObject({ success: true });
    });

    it('treats a throwing result listener as a failed run without crashing the scheduler', async () => {
      setResultListener(() => {
        throw new Error('listener boom');
      });
      queueSpawnClosingWith(0);

      await addSchedule('throwing-listener-job', testHome.path, 'do work', '0 3 * * *');
      await expect(runNow('throwing-listener-job', true)).resolves.toBe(false);

      expect(
        vi
          .mocked(console.error)
          .mock.calls.some(([, err]) => err instanceof Error && err.message === 'listener boom'),
      ).toBe(true);
    });

    it('auto-pauses the schedule after MAX_CONSECUTIVE_FAILURES consecutive failures', async () => {
      await addSchedule('flaky-job', testHome.path, 'do work', '0 3 * * *');

      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
        queueSpawnClosingWith(1); // non-zero exit code == failure
        await runNow('flaky-job', true);
      }

      const [job] = await listSchedules();
      expect(job.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
      expect(job.enabled).toBe(false);
      expect(
        vi.mocked(console.warn).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('auto-paused')),
      ).toBe(true);
    });

    it('caps recent results at MAX_RESULTS by evicting the oldest entry', async () => {
      await addSchedule('bulk-job', testHome.path, 'do work', '0 3 * * *');

      for (let i = 0; i < 51; i += 1) {
        queueSpawnClosingWith(0);
        await runNow('bulk-job', true);
      }

      expect(getRecentResults(100)).toHaveLength(50);
    });
  });

  // ==========================================================
  // removeSchedule
  // ==========================================================

  describe('removeSchedule', () => {
    it('returns false for an unknown name or id', async () => {
      await expect(removeSchedule('does-not-exist')).resolves.toBe(false);
    });

    it('stops the active cron and deletes the schedule', async () => {
      await addSchedule('removable-job', testHome.path, 'do work', '0 3 * * *');
      await expect(removeSchedule('removable-job')).resolves.toBe(true);
      expect(await listSchedules()).toHaveLength(0);
      // A second removal on the now-missing job is a no-op.
      await expect(removeSchedule('removable-job')).resolves.toBe(false);
    });

    it('kills a still-running process when the schedule is removed mid-run', async () => {
      spawnMock.mockImplementationOnce(() => createMockProc()); // never closes — an in-flight run
      await addSchedule('mid-run-job', testHome.path, 'do work', '0 3 * * *');

      const pending = runNow('mid-run-job', true);
      for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(getRunningJobs()).toHaveLength(1);

      await expect(removeSchedule('mid-run-job')).resolves.toBe(true);
      const proc = spawned.processes[0];
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // Let the in-flight run settle so no dangling promise leaks into later tests.
      proc.emit('close', 0);
      await pending;
    });
  });

  // ==========================================================
  // toggleSchedule
  // ==========================================================

  describe('toggleSchedule', () => {
    it('returns null for an unknown name or id', async () => {
      await expect(toggleSchedule('does-not-exist')).resolves.toBeNull();
    });

    it('disables an enabled schedule and stops its cron', async () => {
      await addSchedule('togglable-job', testHome.path, 'do work', '0 3 * * *');
      const toggled = await toggleSchedule('togglable-job');

      expect(toggled?.enabled).toBe(false);
      expect((await listSchedules())[0].enabled).toBe(false);
    });

    it('re-enables a disabled schedule and restarts its cron', async () => {
      await addSchedule('re-enable-job', testHome.path, 'do work', '0 3 * * *');
      await toggleSchedule('re-enable-job'); // disable
      const toggled = await toggleSchedule('re-enable-job'); // re-enable

      expect(toggled?.enabled).toBe(true);
      expect((await listSchedules())[0].enabled).toBe(true);
    });
  });

  // ==========================================================
  // startAllSchedules / stopAllSchedules
  // ==========================================================

  it('starts a cron for every schedule on disk and logs the count, regardless of enabled state', async () => {
    await addSchedule('startall-enabled', testHome.path, 'do work', '0 3 * * *');
    await addSchedule('startall-disabled', testHome.path, 'do work', '0 4 * * *');
    await toggleSchedule('startall-disabled'); // persist enabled:false
    stopAllSchedules(); // clear in-memory cron state, keep the schedule file

    await startAllSchedules();

    expect(
      vi.mocked(console.log).mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('Loading 2 schedules')),
    ).toBe(true);
  });

  it('kills a running process when stopping all schedules', async () => {
    spawnMock.mockImplementationOnce(() => createMockProc()); // never closes
    await addSchedule('stopall-job', testHome.path, 'do work', '0 3 * * *');

    const pending = runNow('stopall-job', true);
    for (let i = 0; i < 20 && getRunningJobs().length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(getRunningJobs()).toHaveLength(1);

    stopAllSchedules();

    expect(getRunningJobs()).toHaveLength(0);
    const proc = spawned.processes[spawned.processes.length - 1];
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('close', 0);
    await pending;
  });
});
