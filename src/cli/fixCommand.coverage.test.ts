// ============================================
// OpenSwarm - fixCommand coverage top-up
// The existing fixCommand.test.ts drives the pure helpers and the
// orchestration loop entirely through injected deps, so it never exercises:
// readScripts/probeProject against a real filesystem, the default
// execFile-based check runner, or the default renderBoard/recordOutcome
// paths (real dynamic imports of fixBoard.js / repoKnowledge.js). This file
// covers those, plus the non-board "plain log" error-reporting branch and
// the all-workers-failed stop condition.
// ============================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScripts, probeProject, resolveProjectChecks, runFixCommand, type Check } from './fixCommand.js';

// Mock the two effectful boundaries fixCommand dynamically imports on the
// default (no injected dep) path, so exercising those branches never renders
// a real Ink board or writes to repo knowledge memory.
const renderFixBoardMock = vi.hoisted(() => vi.fn());
vi.mock('./fixBoard.js', () => ({ renderFixBoard: renderFixBoardMock }));

const recordTaskOutcomeMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../memory/repoKnowledge.js', () => ({ recordTaskOutcome: recordTaskOutcomeMock }));

describe('readScripts (real filesystem)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fixcmd-readscripts-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reads the scripts map from a real package.json', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    expect(readScripts(tmp)).toEqual({ test: 'vitest run' });
  });

  it('returns {} when package.json is missing', async () => {
    expect(readScripts(tmp)).toEqual({});
  });

  it('returns {} when package.json is malformed JSON', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{ not json', 'utf8');
    expect(readScripts(tmp)).toEqual({});
  });
});

describe('probeProject (real filesystem)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fixcmd-probe-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('picks up npm scripts, Cargo.toml, and configured Python tools together', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await fs.writeFile(path.join(tmp, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf8');
    await fs.writeFile(path.join(tmp, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n', 'utf8');
    await fs.mkdir(path.join(tmp, 'tests'));

    const probe = probeProject(tmp);
    expect(probe.npmScripts).toEqual({ test: 'vitest run' });
    expect(probe.cargo).toBe(true);
    expect(probe.python).toEqual({ marker: true, ruff: true, mypy: true, pytest: true });
    expect(probe.configChecks).toBeUndefined();
  });

  it('returns falsy/empty markers for a bare directory with none of the above', async () => {
    const probe = probeProject(tmp);
    expect(probe.npmScripts).toEqual({});
    expect(probe.cargo).toBe(false);
    expect(probe.python).toEqual({ marker: false, ruff: false, mypy: false, pytest: false });
  });

  it('parses openswarm.json checks, preserving only string-valued entries', async () => {
    await fs.writeFile(
      path.join(tmp, 'openswarm.json'),
      JSON.stringify({ checks: { test: 'pytest -x', bogus: 42 } }),
      'utf8',
    );
    const probe = probeProject(tmp);
    expect(probe.configChecks).toEqual({ test: 'pytest -x' });
  });

  it('ignores openswarm.json checks when the value is an array, not a map', async () => {
    await fs.writeFile(path.join(tmp, 'openswarm.json'), JSON.stringify({ checks: ['test'] }), 'utf8');
    const probe = probeProject(tmp);
    expect(probe.configChecks).toBeUndefined();
  });

  it('tolerates a malformed openswarm.json and falls through to auto-detection', async () => {
    await fs.writeFile(path.join(tmp, 'openswarm.json'), '{ not valid json', 'utf8');
    const probe = probeProject(tmp);
    expect(probe.configChecks).toBeUndefined();
  });
});

describe('resolveProjectChecks — resolveTableChecks dedup/unknown-key skip (Cargo table)', () => {
  it('skips a duplicate requested key (the `seen` de-dup branch)', () => {
    // 'lint' requested twice: the 2nd pass hits `seen.has(key)` -> continue,
    // a branch none of the existing single-pass requests exercise.
    const checks = resolveProjectChecks({ cargo: true }, ['lint', 'lint']);
    expect(checks.map((c) => c.key)).toEqual(['lint']);
  });

  it('skips a requested key that has no entry in the check table', () => {
    const checks = resolveProjectChecks({ cargo: true }, ['not-a-real-check']);
    expect(checks).toEqual([]);
  });
});

describe('runFixCommand — default check runner (real execFile)', () => {
  it('reports a passing check via the real default runner (no injected runCheck)', async () => {
    const checks: Check[] = [{ key: 'ok', program: process.execPath, args: ['-e', 'process.exit(0)'] }];
    const report = await runFixCommand(
      { rounds: 1 },
      { log: () => {}, exists: () => true, checks, recordOutcome: async () => {} },
    );
    expect(report.green).toBe(true);
    expect(report.rounds[0].outcomes[0]).toMatchObject({ key: 'ok', passed: true });
  });

  it('reports a failing check via the real default runner (no injected runCheck)', async () => {
    const checks: Check[] = [{ key: 'bad', program: process.execPath, args: ['-e', 'process.exit(1)'] }];
    // rounds: 1 makes the loop break immediately after detecting the failure,
    // before it would fan out to a fix worker (which we don't inject here).
    const report = await runFixCommand(
      { rounds: 1 },
      { log: () => {}, exists: () => true, checks, recordOutcome: async () => {} },
    );
    expect(report.green).toBe(false);
    expect(report.reason).toBe('out-of-rounds');
    expect(report.rounds[0].outcomes[0]).toMatchObject({ key: 'bad', passed: false });
  });
});

describe('runFixCommand — default renderBoard (real dynamic import, mocked fixBoard.js)', () => {
  let originalIsTTY: PropertyDescriptor | undefined;
  beforeEach(() => {
    renderFixBoardMock.mockReset();
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });
  afterEach(() => {
    if (originalIsTTY) Object.defineProperty(process.stderr, 'isTTY', originalIsTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  });

  it('mounts the real (mocked) board when stderr looks like a TTY and no renderBoard dep is injected', async () => {
    const board = { emit: vi.fn(), unmount: vi.fn() };
    renderFixBoardMock.mockReturnValue(board);
    const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];

    const report = await runFixCommand(
      { rounds: 2, concurrency: 2 },
      {
        log: () => {},
        exists: () => true,
        checks,
        recordOutcome: async () => {},
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => ({ success: true, filesChanged: ['src/a/x.ts'] }),
      },
    );

    expect(renderFixBoardMock).toHaveBeenCalledTimes(1);
    expect(board.emit).toHaveBeenCalled();
    expect(board.unmount).toHaveBeenCalledTimes(1);
    expect(report.rounds.length).toBeGreaterThan(0);
  });
});

describe('runFixCommand — default recordOutcome (real dynamic import, mocked repoKnowledge.js)', () => {
  beforeEach(() => {
    recordTaskOutcomeMock.mockClear();
  });

  it('records the outcome via the real recordTaskOutcome when no recordOutcome dep is injected', async () => {
    let pass = false;
    const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
    const report = await runFixCommand(
      { rounds: 3 },
      {
        log: () => {},
        exists: () => true,
        checks,
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );

    expect(report.green).toBe(true);
    expect(recordTaskOutcomeMock).toHaveBeenCalledTimes(1);
    expect(recordTaskOutcomeMock.mock.calls[0][1]).toMatchObject({ derivedFrom: 'cli:fix' });
  });
});

describe('runFixCommand — default log/exists and swallowed side-effect errors', () => {
  it('uses the default console.log + fs.existsSync when log/exists deps are omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
      // A real source path that exists relative to the repo root (process.cwd()
      // while running under vitest), so the default `exists` (fs.existsSync)
      // resolves true for a real file without touching anything outside the repo.
      const report = await runFixCommand(
        { rounds: 1 },
        { checks, recordOutcome: async () => {}, runCheck: async () => ({ passed: false, output: 'src/cli/fixCommand.ts:1 error' }) },
      );
      expect(report.green).toBe(false);
      expect(report.rounds[0].outcomes[0].files).toEqual(['src/cli/fixCommand.ts']);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('swallows a recordOutcome rejection (the .catch on the learn call) without failing the round', async () => {
    let pass = false;
    const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
    const report = await runFixCommand(
      { rounds: 3 },
      {
        log: () => {},
        exists: () => true,
        checks,
        recordOutcome: async () => {
          throw new Error('recording backend down');
        },
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );
    expect(report.green).toBe(true);
  });

  it('forwards the fix worker onLog callback to the board (default renderBoard returns null off-TTY)', async () => {
    const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
    const logLines: string[] = [];
    await runFixCommand(
      { rounds: 2 },
      {
        log: () => {},
        exists: () => true,
        checks,
        recordOutcome: async () => {},
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async (_area, _checks, onLog) => {
          // Exercises the `(line) => board?.emit(...)` forwarding closure; the
          // board is null off-TTY so this is a safe no-op via optional chaining.
          onLog('worker progress line');
          logLines.push('worker ran');
          return { success: true, filesChanged: [] };
        },
      },
    );
    expect(logLines).toEqual(['worker ran']);
  });
});

describe('runFixCommand — plain-log error reporting and all-workers-failed stop', () => {
  it('logs each failed area on plain lines (no board) and stops when every worker throws', async () => {
    const logs: string[] = [];
    const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];

    const report = await runFixCommand(
      { rounds: 2, concurrency: 2 },
      {
        log: (l) => logs.push(l),
        exists: () => true,
        checks,
        recordOutcome: async () => {},
        // Two distinct dirs -> two areas; both workers throw -> no board (not a
        // TTY in this test env) means the plain-log branch handles every error,
        // and since every area fails, the round stops with 'no-progress'.
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail\nsrc/b/y.ts:2 fail' }),
        runFixWorker: async () => {
          throw new Error('worker died');
        },
      },
    );

    expect(report.green).toBe(false);
    expect(report.reason).toBe('no-progress');
    const joined = logs.join('\n');
    expect(joined).toContain('worker error: worker died');
    expect(joined).toContain('All 2 fix worker(s) failed this round — stopping.');
  });
});
