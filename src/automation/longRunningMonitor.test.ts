// ============================================
// OpenSwarm - Long-Running Task Monitor Tests
// ============================================
//
// The module under test holds module-level singleton state (the `monitors`
// Map) and touches `node:fs` / `node:child_process` as side effects. Every
// test gets a fresh module instance via `vi.resetModules()` + dynamic
// `import()` so state never leaks across tests, and every external call is
// mocked so nothing here spawns a real process or touches the real
// `~/.openswarm/openswarm-monitors.json`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: fsMocks.existsSync,
  readFileSync: fsMocks.readFileSync,
  writeFileSync: fsMocks.writeFileSync,
  mkdirSync: fsMocks.mkdirSync,
}));

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const broadcastEventMock = vi.hoisted(() => vi.fn());
vi.mock('../core/eventHub.js', () => ({
  broadcastEvent: broadcastEventMock,
}));

type MonitorModule = typeof import('./longRunningMonitor.js');

async function freshModule(): Promise<MonitorModule> {
  vi.resetModules();
  return import('./longRunningMonitor.js');
}

/**
 * Queue a single execFile response. Node's execFile callback is always
 * invoked asynchronously (never synchronously) — the real implementation
 * relies on that (`proc.exitCode` is read inside the callback, referencing a
 * `const` that is only assigned once `execFile()` returns) so we replicate it
 * with `queueMicrotask` rather than calling back inline.
 */
function queueExecFileResult(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorCode?: number;
}): void {
  execFileMock.mockImplementationOnce(
    (
      _program: string,
      _args: string[],
      _options: unknown,
      callback: (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
    ) => {
      const err = opts.errorCode !== undefined ? Object.assign(new Error('boom'), { code: opts.errorCode }) : null;
      queueMicrotask(() => callback(err, opts.stdout ?? '', opts.stderr ?? ''));
      return { exitCode: opts.exitCode ?? 0 };
    },
  );
}

const HOME = homedir();

describe('longRunningMonitor', () => {
  beforeEach(() => {
    fsMocks.existsSync.mockReset().mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    fsMocks.writeFileSync.mockReset();
    fsMocks.mkdirSync.mockReset();
    execFileMock.mockReset();
    broadcastEventMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================
  // Security-relevant argv/program validation (registerMonitor)
  // ==========================================================

  describe('registerMonitor argv validation', () => {
    it('registers a monitor with an allowlisted bare program', async () => {
      const mod = await freshModule();
      const monitor = mod.registerMonitor({
        id: 'm1',
        name: 'Test',
        checkCommand: ['curl', '-s', 'http://x'],
        completionCheck: { type: 'exit-code' },
      });
      expect(monitor.state).toBe('pending');
      expect(mod.getMonitor('m1')).toBeDefined();
    });

    it('registers a monitor whose checkCommand is an absolute path under an allowed prefix', async () => {
      const mod = await freshModule();
      const monitor = mod.registerMonitor({
        id: 'm2',
        name: 'Script',
        checkCommand: [`${HOME}/scripts/probe.sh`],
        completionCheck: { type: 'exit-code' },
      });
      expect(monitor.state).toBe('pending');
    });

    it('registers a monitor whose checkCommand uses a `~/...` path under an allowed prefix', async () => {
      const mod = await freshModule();
      const monitor = mod.registerMonitor({
        id: 'm2b',
        name: 'Tilde script',
        checkCommand: ['~/.local/bin/probe'],
        completionCheck: { type: 'exit-code' },
      });
      expect(monitor.state).toBe('pending');
    });

    it('rejects a bare program name not in the allowlist', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm3',
          name: 'Bad',
          checkCommand: ['rm', '-rf', '/'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow(/checkCommand/);
    });

    it('rejects an absolute path outside allowed prefixes', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm4',
          name: 'Bad path',
          checkCommand: ['/etc/cron.d/evil'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects a `~/...` path outside allowed prefixes', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm4b',
          name: 'Bad tilde path',
          checkCommand: ['~/Downloads/evil.sh'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects argv containing control characters', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm5',
          name: 'Control char',
          checkCommand: ['curl', 'arg\x01injected'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects an empty argv array', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm6',
          name: 'Empty',
          checkCommand: [],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects a program containing ".."', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm7',
          name: 'Traversal',
          checkCommand: ['../evil'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects an argv element exceeding the 4096-char length cap', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm8',
          name: 'Too long',
          checkCommand: ['curl', 'a'.repeat(4097)],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects an argv element that is an empty string', async () => {
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm9',
          name: 'Empty elem',
          checkCommand: ['curl', ''],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });

    it('rejects a relative path containing a slash that is neither absolute nor tilde-relative', async () => {
      // Exercises the branch in isAllowedAbsolutePath where the program
      // contains '/' (so it skips the bare-name allowlist check) but starts
      // with neither '/' nor '~/' — e.g. "sub/dir/bin".
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({
          id: 'm11',
          name: 'Relative slash',
          checkCommand: ['sub/dir/bin'],
          completionCheck: { type: 'exit-code' },
        }),
      ).toThrow();
    });
  });

  // ==========================================================
  // Persistence: loading from disk (initMonitors -> loadFromDisk)
  // ==========================================================

  describe('initMonitors / persisted state', () => {
    it('does nothing when no persist file exists', async () => {
      fsMocks.existsSync.mockReturnValue(false);
      const mod = await freshModule();
      mod.initMonitors();
      expect(mod.getActiveMonitors()).toHaveLength(0);
      expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    });

    it('restores pending/running monitors and drops already-terminal ones', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          monitors: [
            {
              id: 'r1',
              name: 'Restored',
              checkCommand: ['curl', '-s', 'x'],
              completionCheck: { type: 'exit-code' },
              state: 'running',
              registeredAt: 1,
              checkCount: 0,
              heartbeatsSinceRegister: 0,
            },
            {
              id: 'r2',
              name: 'Already done',
              checkCommand: ['curl'],
              completionCheck: { type: 'exit-code' },
              state: 'completed',
              registeredAt: 1,
              checkCount: 0,
              heartbeatsSinceRegister: 0,
            },
          ],
          updatedAt: new Date().toISOString(),
        }),
      );
      const mod = await freshModule();
      mod.initMonitors();
      expect(mod.getMonitor('r1')).toBeDefined();
      expect(mod.getMonitor('r2')).toBeUndefined();
    });

    it('skips legacy monitors with a string checkCommand instead of crashing', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          monitors: [
            {
              id: 'legacy1',
              name: 'Legacy',
              checkCommand: 'curl -s x',
              completionCheck: { type: 'exit-code' },
              state: 'running',
              registeredAt: 1,
              checkCount: 0,
              heartbeatsSinceRegister: 0,
            },
          ],
          updatedAt: new Date().toISOString(),
        }),
      );
      const mod = await freshModule();
      mod.initMonitors();
      expect(mod.getMonitor('legacy1')).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    it('does not crash on malformed persisted JSON', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue('{ not valid json');
      const mod = await freshModule();
      expect(() => mod.initMonitors()).not.toThrow();
      expect(mod.getActiveMonitors()).toHaveLength(0);
    });

    it('registers config.yaml monitors that are not already present', async () => {
      fsMocks.existsSync.mockReturnValue(false);
      const mod = await freshModule();
      mod.initMonitors([
        { id: 'cfg1', name: 'From config', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } },
      ]);
      expect(mod.getMonitor('cfg1')).toBeDefined();
    });

    it('does not overwrite a monitor restored from disk with the config.yaml version of the same id', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(
        JSON.stringify({
          monitors: [
            {
              id: 'dup1',
              name: 'From disk',
              checkCommand: ['curl'],
              completionCheck: { type: 'exit-code' },
              state: 'running',
              registeredAt: 1,
              checkCount: 5,
              heartbeatsSinceRegister: 5,
            },
          ],
          updatedAt: new Date().toISOString(),
        }),
      );
      const mod = await freshModule();
      mod.initMonitors([
        { id: 'dup1', name: 'From config (should be ignored)', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } },
      ]);
      expect(mod.getMonitor('dup1')?.checkCount).toBe(5);
    });
  });

  // ==========================================================
  // Persistence: writing to disk (registerMonitor/unregisterMonitor -> saveToDisk)
  // ==========================================================

  describe('persistence writes', () => {
    it('persists to disk on register, creating the directory first', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'p1', name: 'Persisted', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(fsMocks.writeFileSync).toHaveBeenCalled();
      const [, payload] = fsMocks.writeFileSync.mock.calls[0];
      const parsed = JSON.parse(payload as string);
      expect(parsed.monitors).toHaveLength(1);
      expect(parsed.monitors[0].id).toBe('p1');
    });

    it('persists an empty monitor list after unregistering the only monitor', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'p2', name: 'Temp', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      fsMocks.writeFileSync.mockClear();
      const removed = mod.unregisterMonitor('p2');
      expect(removed).toBe(true);
      const [, payload] = fsMocks.writeFileSync.mock.calls[0];
      expect(JSON.parse(payload as string).monitors).toHaveLength(0);
    });

    it('returns false when unregistering an unknown id', async () => {
      const mod = await freshModule();
      expect(mod.unregisterMonitor('nope')).toBe(false);
    });

    it('does not crash when writeFileSync throws', async () => {
      fsMocks.writeFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      const mod = await freshModule();
      expect(() =>
        mod.registerMonitor({ id: 'p3', name: 'X', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } }),
      ).not.toThrow();
      expect(console.warn).toHaveBeenCalled();
    });
  });

  // ==========================================================
  // checkAllMonitors + evaluateResult (exit-code)
  // ==========================================================

  describe('checkAllMonitors — exit-code completion checks', () => {
    it('returns 0 immediately when there are no active monitors', async () => {
      const mod = await freshModule();
      await expect(mod.checkAllMonitors()).resolves.toBe(0);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('keeps a monitor running while exit code matches the success code', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'e1', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      queueExecFileResult({ exitCode: 0, stdout: '' });
      const count = await mod.checkAllMonitors();
      expect(count).toBe(1);
      expect(mod.getMonitor('e1')?.state).toBe('running');
    });

    it('marks a monitor completed once exit code diverges from the success code', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'e2', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      queueExecFileResult({ exitCode: 1, stdout: '' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('e2')?.state).toBe('completed');
    });

    it('honors a custom successExitCode', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'e3',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'exit-code', successExitCode: 2 },
      });
      queueExecFileResult({ exitCode: 2, stdout: '' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('e3')?.state).toBe('running');
    });
  });

  // ==========================================================
  // checkAllMonitors + evaluateResult (output-regex / outputIncludesPattern)
  // ==========================================================

  describe('checkAllMonitors — output-regex completion checks', () => {
    it('completes when stdout includes the success pattern', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'o1',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: 'DONE' },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'job status: DONE' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o1')?.state).toBe('completed');
    });

    it('fails when stdout includes the failure pattern, even if the success pattern also matches', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'o2',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: 'DONE', failurePattern: 'ERROR' },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'ERROR: job DONE with failure' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o2')?.state).toBe('failed');
    });

    it('stays running when neither pattern matches', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'o3',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: 'DONE' },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'still working' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o3')?.state).toBe('running');
    });

    it('treats an over-length success pattern as non-matching, even if stdout contains it literally', async () => {
      const mod = await freshModule();
      const longPattern = 'D'.repeat(513); // one char past MAX_OUTPUT_PATTERN_LENGTH (512)
      mod.registerMonitor({
        id: 'o4',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: longPattern },
      });
      queueExecFileResult({ exitCode: 0, stdout: `prefix ${longPattern} suffix` });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o4')?.state).toBe('running');
    });

    it('treats a success pattern with disallowed control characters as non-matching', async () => {
      const mod = await freshModule();
      const badPattern = 'bad\x01char';
      mod.registerMonitor({
        id: 'o5',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: badPattern },
      });
      queueExecFileResult({ exitCode: 0, stdout: `contains ${badPattern} literally` });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o5')?.state).toBe('running');
    });

    it('stays running when no failurePattern is configured (undefined pattern short-circuits to no-match)', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'o6',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'output-regex', successPattern: 'DONE' },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'neither pattern here' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('o6')?.state).toBe('running');
    });
  });

  // ==========================================================
  // checkAllMonitors + evaluateResult (http-status)
  // ==========================================================

  describe('checkAllMonitors — http-status completion checks', () => {
    it('completes when the expected status code is found in stdout and exit code is 0', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'h1',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'http-status', expectedStatus: 200 },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'HTTP/1.1 200 OK' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('h1')?.state).toBe('completed');
    });

    it('stays running when the status code does not match', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'h2',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'http-status', expectedStatus: 200 },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'HTTP/1.1 404 Not Found' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('h2')?.state).toBe('running');
    });

    it('fails when the exit code is non-zero', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'h3',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'http-status', expectedStatus: 200 },
      });
      queueExecFileResult({ exitCode: 1, stdout: 'connection refused' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('h3')?.state).toBe('failed');
    });

    it('defaults expectedStatus to 200 when not specified', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 'h4',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'http-status' },
      });
      queueExecFileResult({ exitCode: 0, stdout: 'HTTP/1.1 200 OK' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('h4')?.state).toBe('completed');
    });
  });

  // ==========================================================
  // executeCheck internals: execFile error mapping and defaults
  // ==========================================================

  describe('checkAllMonitors — executeCheck error handling and defaults', () => {
    it('surfaces an execFile crash without throwing out of checkAllMonitors', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'x1', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      execFileMock.mockImplementationOnce(() => {
        throw new Error('spawn EAGAIN');
      });
      const count = await mod.checkAllMonitors();
      expect(count).toBe(0); // the check errored before it could be counted
      expect(console.error).toHaveBeenCalled();
      expect(mod.getMonitor('x1')?.state).toBe('pending'); // untouched — the check never resolved
    });

    it('maps an execFile error with a numeric code to that exit code', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'x2', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      execFileMock.mockImplementationOnce(
        (_p: string, _a: string[], _o: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
          const err = Object.assign(new Error('curl failed'), { code: 7 });
          queueMicrotask(() => callback(err, '', 'connection failed'));
          return { exitCode: 0 }; // must be ignored — error.code takes precedence
        },
      );
      await mod.checkAllMonitors();
      expect(mod.getMonitor('x2')?.lastExitCode).toBe(7);
      expect(mod.getMonitor('x2')?.state).toBe('completed'); // 7 !== default successExitCode(0)
    });

    it('falls back to exit code 1 when the execFile error code is not numeric', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'x3', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      execFileMock.mockImplementationOnce(
        (_p: string, _a: string[], _o: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
          const err = Object.assign(new Error('killed'), { code: 'ENOENT' });
          queueMicrotask(() => callback(err, '', ''));
          return { exitCode: 0 };
        },
      );
      await mod.checkAllMonitors();
      expect(mod.getMonitor('x3')?.lastExitCode).toBe(1);
    });

    it('defaults to exit code 0 when execFile succeeds without a numeric proc.exitCode', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'x4', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      execFileMock.mockImplementationOnce(
        (_p: string, _a: string[], _o: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
          queueMicrotask(() => callback(null, 'ok', ''));
          return {}; // no exitCode property at all
        },
      );
      await mod.checkAllMonitors();
      expect(mod.getMonitor('x4')?.lastExitCode).toBe(0);
      expect(mod.getMonitor('x4')?.state).toBe('running'); // 0 matches default successExitCode
    });

    it('normalizes undefined stdout/stderr from execFile to empty strings', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'x5', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      execFileMock.mockImplementationOnce(
        (
          _p: string,
          _a: string[],
          _o: unknown,
          callback: (err: null, stdout: string | undefined, stderr: string | undefined) => void,
        ) => {
          queueMicrotask(() => callback(null, undefined, undefined));
          return { exitCode: 0 };
        },
      );
      await mod.checkAllMonitors();
      expect(mod.getMonitor('x5')?.lastOutput).toBe('');
    });
  });

  // ==========================================================
  // State machine behavior: transitions, heartbeat gating, timeout
  // ==========================================================

  describe('checkAllMonitors — state machine behavior', () => {
    it('auto-transitions pending to running on the first successful check', async () => {
      const mod = await freshModule();
      const monitor = mod.registerMonitor({
        id: 's1',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'exit-code' },
      });
      expect(monitor.state).toBe('pending');
      queueExecFileResult({ exitCode: 0, stdout: '' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('s1')?.state).toBe('running');
    });

    it('broadcasts a monitor:stateChange event and persists when state changes', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 's2', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      broadcastEventMock.mockClear();
      fsMocks.writeFileSync.mockClear();
      queueExecFileResult({ exitCode: 1, stdout: '' }); // diverges from success -> completed
      await mod.checkAllMonitors();
      expect(broadcastEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'monitor:stateChange',
          data: expect.objectContaining({ id: 's2', from: 'pending', to: 'completed' }),
        }),
      );
      expect(fsMocks.writeFileSync).toHaveBeenCalled();
    });

    it('does not run a check on heartbeats that do not divide the checkInterval', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 's3',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'exit-code' },
        checkInterval: 2,
      });
      const count = await mod.checkAllMonitors(); // heartbeat 1 of 2 -> skipped
      expect(count).toBe(0);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('runs the check once the checkInterval heartbeat count is reached', async () => {
      const mod = await freshModule();
      mod.registerMonitor({
        id: 's4',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'exit-code' },
        checkInterval: 2,
      });
      await mod.checkAllMonitors(); // heartbeat 1 -> skip
      queueExecFileResult({ exitCode: 0, stdout: '' });
      const count = await mod.checkAllMonitors(); // heartbeat 2 -> run
      expect(count).toBe(1);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('transitions to timeout once maxDurationHours has elapsed, without invoking the check command', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const mod = await freshModule();
      mod.registerMonitor({
        id: 's5',
        name: 'Job',
        checkCommand: ['curl'],
        completionCheck: { type: 'exit-code' },
        maxDurationHours: 1,
      });
      now += 60 * 60 * 1000 + 1; // just over 1 hour later
      const count = await mod.checkAllMonitors();
      expect(mod.getMonitor('s5')?.state).toBe('timeout');
      expect(count).toBe(0); // the timeout branch `continue`s before incrementing checkedCount
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('does not broadcast a stateChange event when a check leaves the state unchanged', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'noop1', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      queueExecFileResult({ exitCode: 0, stdout: '' });
      await mod.checkAllMonitors(); // pending -> running (a real transition)
      expect(mod.getMonitor('noop1')?.state).toBe('running');

      broadcastEventMock.mockClear();
      queueExecFileResult({ exitCode: 0, stdout: '' });
      await mod.checkAllMonitors(); // running -> running (no transition: handleStateTransition early-returns)
      expect(mod.getMonitor('noop1')?.state).toBe('running');
      // Only the unconditional 'monitor:checked' event fires; 'monitor:stateChange' does not.
      expect(broadcastEventMock).toHaveBeenCalledTimes(1);
      expect(broadcastEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'monitor:checked' }));
    });

    it('does not re-run a completed monitor on subsequent checkAllMonitors calls', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 's6', name: 'Job', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      queueExecFileResult({ exitCode: 1, stdout: '' });
      await mod.checkAllMonitors();
      expect(mod.getMonitor('s6')?.state).toBe('completed');
      execFileMock.mockClear();
      const count = await mod.checkAllMonitors();
      expect(count).toBe(0);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================
  // Simple accessors
  // ==========================================================

  describe('getActiveMonitors / getMonitor', () => {
    it('returns all registered monitors regardless of state', async () => {
      const mod = await freshModule();
      mod.registerMonitor({ id: 'g1', name: 'A', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      mod.registerMonitor({ id: 'g2', name: 'B', checkCommand: ['curl'], completionCheck: { type: 'exit-code' } });
      expect(mod.getActiveMonitors().map(m => m.id).sort()).toEqual(['g1', 'g2']);
    });

    it('returns undefined for an unknown id', async () => {
      const mod = await freshModule();
      expect(mod.getMonitor('missing')).toBeUndefined();
    });
  });
});
