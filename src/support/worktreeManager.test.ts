import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktreeManager.js';

describe('worktreeManager path safety', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = join(tmpdir(), `openswarm-worktree-manager-${process.pid}-${Date.now()}`);
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects issue IDs that are not a single safe path segment', async () => {
    await expect(createWorktree(repo, '../outside', 'swarm/INT-1-test')).rejects.toThrow(/Invalid worktree issueId/);
  });

  it('refuses to remove a worktree path outside the managed worktree root', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep');

    const info: WorktreeInfo = {
      originalPath: repo,
      worktreePath: outside,
      branchName: 'swarm/INT-1-test',
      issueId: 'INT-1',
    };

    await expect(removeWorktree(info)).rejects.toThrow(/Refusing to remove unmanaged worktree path/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('allows fallback removal only inside the managed worktree root', async () => {
    const managedPath = resolve(repo, 'worktree', 'INT-1');
    mkdirSync(managedPath, { recursive: true });
    writeFileSync(join(managedPath, 'remove.txt'), 'remove');

    const info: WorktreeInfo = {
      originalPath: repo,
      worktreePath: managedPath,
      branchName: 'swarm/INT-1-test',
      issueId: 'INT-1',
    };

    await removeWorktree(info);
    expect(existsSync(managedPath)).toBe(false);
  });
});
