import { describe, it, expect, vi } from 'vitest';
import {
  resolveChecks,
  parseFailingFiles,
  deriveFixAreas,
  buildFixCheckTask,
  runFixCommand,
  type Check,
  type CheckOutcome,
  type FixArea,
} from './fixCommand.js';

describe('resolveChecks (INT-2267)', () => {
  const scripts = { lint: 'oxlint src/', typecheck: 'tsc --noEmit', build: 'tsc', test: 'vitest run', dev: 'x' };

  it('defaults to the standard checks that have a script, in order', () => {
    expect(resolveChecks(scripts).map((c) => c.key)).toEqual(['lint', 'typecheck', 'build', 'test']);
  });

  it('maps requested keys (incl. the `type` alias) and drops unknown/missing', () => {
    expect(resolveChecks(scripts, ['type', 'test', 'nope']).map((c) => c.key)).toEqual(['typecheck', 'test']);
  });

  it('resolves to `npm run <script>`', () => {
    expect(resolveChecks(scripts, ['lint'])[0]).toEqual({ key: 'lint', program: 'npm', args: ['run', 'lint'] });
  });

  it('drops a requested check with no matching script', () => {
    expect(resolveChecks({ test: 'vitest' }, ['lint', 'test']).map((c) => c.key)).toEqual(['test']);
  });
});

describe('parseFailingFiles (INT-2267)', () => {
  it('extracts paths from tsc / vitest / eslint output and dedupes', () => {
    const out = [
      'src/cli/fixCommand.ts(12,5): error TS2322: bad',
      ' FAIL  src/cli/fixCommand.test.ts > x',
      'src/cli/fixCommand.ts:40:1  error  no-unused',
      './lib/util.py:3: E501',
    ].join('\n');
    const files = parseFailingFiles(out).sort();
    expect(files).toEqual(['lib/util.py', 'src/cli/fixCommand.test.ts', 'src/cli/fixCommand.ts']);
  });

  it('ignores absolute paths and non-source text', () => {
    expect(parseFailingFiles('all good, no files here')).toEqual([]);
    expect(parseFailingFiles('/usr/lib/node/x.js failed')).toEqual([]);
  });
});

describe('deriveFixAreas (INT-2267)', () => {
  const oc = (key: string, files: string[], output = 'boom'): CheckOutcome => ({ key, passed: false, output, files });

  it('partitions blamed files into areas and attaches relevant failures', () => {
    const areas = deriveFixAreas([oc('typecheck', ['src/a/x.ts', 'src/b/y.ts'])], 4, 12);
    expect(areas.length).toBeGreaterThanOrEqual(1);
    expect(areas.flatMap((a) => a.files).sort()).toEqual(['src/a/x.ts', 'src/b/y.ts']);
    expect(areas[0].failures.join('')).toContain('[typecheck]');
  });

  it('makes a check:<key> area for a failing check with no parseable files', () => {
    const areas = deriveFixAreas([oc('build', [], 'Error: config broken')], 4, 12);
    expect(areas).toHaveLength(1);
    expect(areas[0].label).toBe('check:build');
    expect(areas[0].files).toEqual([]);
    expect(areas[0].failures[0]).toContain('config broken');
  });
});

describe('buildFixCheckTask (INT-2267)', () => {
  const area: FixArea = { label: 'src/a', dir: 'src/a', files: ['src/a/x.ts'], failures: ['[typecheck]\nTS2322'] };
  const checks: Check[] = [{ key: 'typecheck', program: 'npm', args: ['run', 'typecheck'] }];

  it('scopes to the files, includes the failure, and forbids cheating', () => {
    const t = buildFixCheckTask(area, checks);
    expect(t).toContain('src/a/x.ts');
    expect(t).toContain('TS2322');
    expect(t).toContain('npm run typecheck');
    expect(t.toLowerCase()).toContain('do not');
  });
});

describe('runFixCommand loop (INT-2267)', () => {
  const checks: Check[] = [{ key: 'test', program: 'npm', args: ['run', 'test'] }];
  const silent = { log: () => {}, exists: () => true, checks, recordOutcome: async () => {} };

  it('returns green without fixing when everything passes', async () => {
    const runFixWorker = vi.fn();
    const report = await runFixCommand(
      { rounds: 3 },
      { ...silent, runCheck: async () => ({ passed: true, output: '' }), runFixWorker },
    );
    expect(report.green).toBe(true);
    expect(report.reason).toBe('green');
    expect(runFixWorker).not.toHaveBeenCalled();
  });

  it('converges: fail → fix → pass', async () => {
    let pass = false;
    const runFixWorker = vi.fn(async () => {
      pass = true; // the fix makes the next check pass
      return { success: true, filesChanged: ['src/a/x.ts'] };
    });
    const report = await runFixCommand(
      { rounds: 3 },
      { ...silent, runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }), runFixWorker },
    );
    expect(report.green).toBe(true);
    expect(runFixWorker).toHaveBeenCalledTimes(1);
    expect(report.rounds).toHaveLength(2);
  });

  it('stops on no progress (same failures, no edits)', async () => {
    const report = await runFixCommand(
      { rounds: 5 },
      {
        ...silent,
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => ({ success: false, filesChanged: [] }),
      },
    );
    expect(report.green).toBe(false);
    expect(report.reason).toBe('no-progress');
  });

  it('gives up after the round budget when it keeps editing but never passes', async () => {
    const report = await runFixCommand(
      { rounds: 2 },
      {
        ...silent,
        runCheck: async () => ({ passed: false, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => ({ success: true, filesChanged: ['src/a/x.ts'] }),
      },
    );
    expect(report.green).toBe(false);
    expect(report.reason).toBe('out-of-rounds');
  });

  it('reports no-checks when nothing resolves', async () => {
    const report = await runFixCommand({}, { log: () => {}, checks: [] });
    expect(report.reason).toBe('no-checks');
  });

  it('records the outcome into repo knowledge on green after edits (INT-2268)', async () => {
    let pass = false;
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand(
      { rounds: 3 },
      {
        ...silent,
        recordOutcome,
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );
    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome.mock.calls[0][0].filesChanged).toEqual(['src/a/x.ts']);
  });

  it('does not record when already green (nothing was edited)', async () => {
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand({ rounds: 3 }, { ...silent, recordOutcome, runCheck: async () => ({ passed: true, output: '' }) });
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('does not record when --no-learn (learn: false)', async () => {
    let pass = false;
    const recordOutcome = vi.fn(async () => {});
    await runFixCommand(
      { rounds: 3, learn: false },
      {
        ...silent,
        recordOutcome,
        runCheck: async () => ({ passed: pass, output: 'src/a/x.ts:1 fail' }),
        runFixWorker: async () => {
          pass = true;
          return { success: true, filesChanged: ['src/a/x.ts'] };
        },
      },
    );
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});
