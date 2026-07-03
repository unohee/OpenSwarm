import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChangedFiles, getChangedFilesSinceSnapshot, getWorkingDiffDetail, takeSnapshot } from './gitTracker.js';

describe('gitTracker', () => {
  let repo: string;

  beforeEach(() => {
    repo = join(tmpdir(), `openswarm-git-tracker-${process.pid}-${Date.now()}`);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  });

  afterEach(() => {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('includes untracked files changed since a snapshot', async () => {
    const snapshot = await takeSnapshot(repo);
    writeFileSync(join(repo, 'new-file.txt'), 'new\n');

    await expect(getChangedFilesSinceSnapshot(repo, snapshot)).resolves.toContain('new-file.txt');
  });

  it('excludes pre-existing dirty files, reporting only changes after the snapshot (INT-2447)', async () => {
    // Repo is ALREADY dirty before the snapshot: an untracked file + a modified
    // tracked file. Previously the HEAD-only snapshot blamed the worker for both.
    writeFileSync(join(repo, 'preexisting-untracked.txt'), 'junk\n');
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\n');
    const snapshot = await takeSnapshot(repo);

    // Now the "worker" makes ITS edit.
    writeFileSync(join(repo, 'worker-edit.txt'), 'fix\n');

    const changed = await getChangedFilesSinceSnapshot(repo, snapshot);
    expect(changed).toContain('worker-edit.txt');              // the worker's edit is reported
    expect(changed).not.toContain('preexisting-untracked.txt'); // pre-existing dirt is NOT attributed
    expect(changed).not.toContain('tracked.txt');              // pre-existing modification is NOT attributed
  });

  it('reports a worker edit to an already-dirty tracked file (no false negative) (INT-2447)', async () => {
    // A file dirty before the snapshot that the worker ALSO edits must still be
    // reported — the snapshot captures content, so a further change is detected.
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\n');
    const snapshot = await takeSnapshot(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\ndirty-before\nworker-added\n');

    await expect(getChangedFilesSinceSnapshot(repo, snapshot)).resolves.toContain('tracked.txt');
  });

  it('includes untracked files in current change detection', async () => {
    writeFileSync(join(repo, 'new-current.txt'), 'new\n');

    await expect(getChangedFiles(repo)).resolves.toContain('new-current.txt');
  });

  describe('getWorkingDiffDetail', () => {
    it('reports per-file added/deleted for a tracked modification', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\nline2\nline3\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t).toBeDefined();
      expect(t!.added).toBe(2);
      expect(t!.deleted).toBe(0);
      expect(t!.isNew).toBe(false);
      expect(t!.whitespaceOnly).toBe(false);
    });

    it('flags a newly-created file as isNew', async () => {
      writeFileSync(join(repo, 'fresh.ts'), 'export const x = 1;\n');
      const detail = await getWorkingDiffDetail(repo);
      const f = detail.find(d => d.file === 'fresh.ts');
      expect(f).toBeDefined();
      expect(f!.isNew).toBe(true);
    });

    it('flags a staged newly-created file as isNew', async () => {
      writeFileSync(join(repo, 'staged-fresh.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', 'staged-fresh.ts'], { cwd: repo });
      const detail = await getWorkingDiffDetail(repo);
      const f = detail.find(d => d.file === 'staged-fresh.ts');
      expect(f).toBeDefined();
      expect(f!.isNew).toBe(true);
      expect(f!.added).toBe(1);
    });

    it('marks a whitespace-only change as whitespaceOnly', async () => {
      // Re-indent the existing line without changing its tokens.
      writeFileSync(join(repo, 'tracked.txt'), '  tracked\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t).toBeDefined();
      expect(t!.whitespaceOnly).toBe(true);
    });

    it('does NOT mark a semantic change as whitespaceOnly', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked-changed\n');
      const detail = await getWorkingDiffDetail(repo);
      const t = detail.find(d => d.file === 'tracked.txt');
      expect(t!.whitespaceOnly).toBe(false);
    });

    it('returns [] for a non-git directory', async () => {
      const notGit = join(tmpdir(), `openswarm-notgit-${process.pid}-${Date.now()}`);
      mkdirSync(notGit, { recursive: true });
      try {
        await expect(getWorkingDiffDetail(notGit)).resolves.toEqual([]);
      } finally {
        rmSync(notGit, { recursive: true, force: true });
      }
    });
  });
});
