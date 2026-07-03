import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, resolveSharedPaths, computeFileOverlaps, formatOverlapReport, type WorktreeInfo } from './worktreeManager.js';

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

describe('resolveSharedPaths (INT-2415)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = join(tmpdir(), `openswarm-shared-paths-${process.pid}-${Date.now()}`);
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects node_modules/.venv/venv that exist at the repo root', () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(join(repo, '.venv'), { recursive: true });
    // venv is absent → excluded; only existing candidates are returned.
    expect(resolveSharedPaths(repo, null).sort()).toEqual(['.venv', 'node_modules']);
  });

  it('returns [] when no auto-detect candidates exist', () => {
    expect(resolveSharedPaths(repo)).toEqual([]);
  });

  it('uses sandbox.sharedPaths verbatim (existing only) and overrides auto-detect', () => {
    mkdirSync(join(repo, 'db'), { recursive: true });
    writeFileSync(join(repo, 'db', 'prod.db'), 'x');
    mkdirSync(join(repo, 'node_modules'), { recursive: true }); // present but NOT in config
    const result = resolveSharedPaths(repo, { sandbox: { sharedPaths: ['db', 'missing-dir'] } });
    // Only existing configured paths; node_modules is dropped because config takes over.
    expect(result).toEqual(['db']);
  });

  it('falls back to auto-detect when sharedPaths is an empty array', () => {
    mkdirSync(join(repo, 'venv'), { recursive: true });
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: [] } })).toEqual(['venv']);
  });

  it('drops absolute and parent-escaping entries', () => {
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: ['/etc', '../secrets', ''] } })).toEqual([]);
  });
});

describe('createWorktree shared-path symlinks (INT-2415)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = join(tmpdir(), `openswarm-worktree-link-${process.pid}-${Date.now()}`);
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    // Best-effort worktree teardown before removing the tree.
    try { git(repo, 'worktree', 'remove', '--force', join(repo, 'worktree', 'INT-1')); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('symlinks the repo node_modules into the worktree without clobbering tracked dirs', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    // A tracked source dir (checked out into the worktree from origin/main).
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Gitignored dep present only in the original working tree (untracked).
    mkdirSync(join(repo, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    // node_modules is a symlink pointing at the original repo's node_modules.
    const wtNodeModules = join(info.worktreePath, 'node_modules');
    expect(lstatSync(wtNodeModules).isSymbolicLink()).toBe(true);
    expect(realpathSync(wtNodeModules)).toBe(realpathSync(join(repo, 'node_modules')));
    // The shared dep is reachable through the link.
    expect(existsSync(join(wtNodeModules, 'leftpad', 'index.js'))).toBe(true);

    // The tracked dir is a real checked-out dir, never replaced by a symlink.
    const wtSrc = join(info.worktreePath, 'src');
    expect(existsSync(join(wtSrc, 'index.ts'))).toBe(true);
    expect(lstatSync(wtSrc).isSymbolicLink()).toBe(false);
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
