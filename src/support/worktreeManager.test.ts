import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, computeFileOverlaps, formatOverlapReport, type WorktreeInfo } from './worktreeManager.js';

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

describe('file-overlap report (INT-2392)', () => {
  describe('computeFileOverlaps', () => {
    it('returns only scopes that share a file, with just the shared files', () => {
      const self = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      const others = [
        { label: 'PR #206 (feat/x)', files: ['src/b.ts', 'src/z.ts'] },
        { label: 'PR #207 (feat/y)', files: ['src/q.ts'] }, // no overlap
        { label: 'branch origin/swarm/foo', files: ['src/a.ts', 'src/c.ts'] },
      ];
      const result = computeFileOverlaps(self, others);
      expect(result).toEqual([
        { label: 'PR #206 (feat/x)', files: ['src/b.ts'] },
        { label: 'branch origin/swarm/foo', files: ['src/a.ts', 'src/c.ts'] },
      ]);
    });

    it('returns [] when nothing overlaps', () => {
      expect(computeFileOverlaps(['a.ts'], [{ label: 'p', files: ['b.ts'] }])).toEqual([]);
    });

    it('returns [] for empty self', () => {
      expect(computeFileOverlaps([], [{ label: 'p', files: ['a.ts'] }])).toEqual([]);
    });
  });

  describe('formatOverlapReport', () => {
    it('returns empty string when there are no overlaps', () => {
      expect(formatOverlapReport([])).toBe('');
    });

    it('renders a markdown section listing each overlapping scope', () => {
      const section = formatOverlapReport([
        { label: 'PR #206 (feat/x)', files: ['src/b.ts'] },
      ]);
      expect(section).toContain('File overlap');
      expect(section).toContain('PR #206 (feat/x)');
      expect(section).toContain('`src/b.ts`');
      expect(section).toContain('INT-2388 #3');
    });

    it('truncates long file lists with a (+N more) suffix', () => {
      const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
      const section = formatOverlapReport([{ label: 'PR #1 (b)', files }]);
      expect(section).toContain('12 file(s)');
      expect(section).toContain('(+4 more)');
    });
  });
});
