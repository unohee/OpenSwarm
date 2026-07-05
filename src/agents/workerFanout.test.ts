import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerOptions } from './worker.js';

const runWorker = vi.fn();
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

const baseWorkerOptions = {
  projectPath: '',
  adapterName: 'codex-responses',
  model: 'gpt-5.4-mini',
  timeoutMs: 0,
} as unknown as WorkerOptions;

describe('runWorkerFanout on a dirty worktree', () => {
  it('seeds pre-existing uncommitted changes and promotes only the incremental winner diff', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-dirty-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);

      // Make the project worktree DIRTY (a self-repair retry still holding the
      // previous iteration's edits): a tracked modification + an untracked file.
      await writeFile(path.join(repo, 'README.md'), 'base\npreexisting-edit\n', 'utf8');
      await writeFile(path.join(repo, 'preexisting.txt'), 'from a prior iteration\n', 'utf8');

      // Each candidate adds its own new file on top of the seeded dirty base.
      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        const file = isSpark ? 'spark.txt' : 'primary.txt';
        await writeFile(path.join(opts.projectPath, file), isSpark ? 'spark\n' : 'primary\n', 'utf8');
        return {
          success: true,
          summary: isSpark ? 'spark patch' : 'primary patch',
          filesChanged: [file],
          commands: [],
          output: '',
          confidencePercent: isSpark ? 95 : 70,
        };
      });

      const { runWorkerFanout } = await import('./workerFanout.js');
      const result = await runWorkerFanout({
        projectPath: repo,
        baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
        candidates: [
          { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
          { id: 'spark-diversity', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
        ],
        concurrency: 2,
      });

      // Fan-out ran (not bailed on the dirty tree) and picked the higher-confidence spark.
      expect(result.fallbackReason).toBeUndefined();
      expect(result.winner?.id).toBe('spark-diversity');
      expect(runWorker).toHaveBeenCalledTimes(2);

      // The pre-existing dirty state survives, AND the winner's incremental diff
      // is layered on top of it — the loser's file is not promoted.
      expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('base\npreexisting-edit\n');
      expect(existsSync(path.join(repo, 'preexisting.txt'))).toBe(true);
      expect(await readFile(path.join(repo, 'spark.txt'), 'utf8')).toBe('spark\n');
      expect(existsSync(path.join(repo, 'primary.txt'))).toBe(false);
      // filesChanged reflects the promoted worktree (accumulated dirty base +
      // the winner's increment) so downstream review sees the full change set —
      // it includes spark.txt but never the losing candidate's primary.txt.
      expect(result.winner?.result.filesChanged).toEqual(
        expect.arrayContaining(['spark.txt', 'README.md', 'preexisting.txt']),
      );
      expect(result.winner?.result.filesChanged).not.toContain('primary.txt');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
