import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChangedFiles, getChangedFilesSinceSnapshot, takeSnapshot } from './gitTracker.js';

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

  it('includes untracked files in current change detection', async () => {
    writeFileSync(join(repo, 'new-current.txt'), 'new\n');

    await expect(getChangedFiles(repo)).resolves.toContain('new-current.txt');
  });
});
