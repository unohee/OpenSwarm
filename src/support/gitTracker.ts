// ============================================
// OpenSwarm - Git Tracker
// Aider-style Git diff-based file change tracking
// ============================================

import { spawn } from 'node:child_process';

// Build/test artifacts + OpenSwarm's own metadata must NEVER enter a PR. Target repos often have
// incomplete .gitignores (e.g. vega-agent ignores coverage.json but not the bare `.coverage` file),
// so `git add -A` sweeps them in (vega-agent PR #48 leaked `.coverage` + `.openswarm/*`). These
// pathspecs are excluded at every staging point. Keep the leading "." — `git add` requires at least
// one positive pathspec alongside the `:(exclude)` ones.
const ARTIFACT_EXCLUDE_PATHSPECS = [
  '.',
  ':(exclude).openswarm',         // OpenSwarm snapshots + timeout-handoff — regenerated every run
  ':(exclude).coverage',
  ':(exclude).coverage.*',
  ':(exclude)htmlcov',
  ':(exclude).pytest_cache',
  ':(exclude).mypy_cache',
  ':(exclude).ruff_cache',
  ':(exclude).tox',
  ':(exclude)**/__pycache__',
  ':(exclude)*.pyc',
  ':(exclude).DS_Store',
];

// Artifacts a PRIOR commit on the branch may already track — untrack them so they leave the PR diff.
const ARTIFACT_CACHED_PATHS = ['.openswarm', '.coverage', 'htmlcov', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'];

/**
 * Stage all work like `git add -A`, but exclude build/test artifacts and OpenSwarm metadata, and
 * drop any such files a previous commit already tracked. Use this everywhere instead of a bare
 * `git add -A` so junk dotfiles never reach a PR.
 */
export async function stageWorkExcludingArtifacts(repoPath: string): Promise<void> {
  await runGitCommand(repoPath, ['add', '-A', '--', ...ARTIFACT_EXCLUDE_PATHSPECS]);
  await runGitCommand(repoPath, ['rm', '-r', '--cached', '--ignore-unmatch', ...ARTIFACT_CACHED_PATHS]).catch(() => {});
}

/**
 * Extract changed file list via git diff
 * Track actual changed files without relying on Worker JSON parsing
 */
export async function getChangedFiles(
  projectPath: string,
  since?: string // commit hash or HEAD~1
): Promise<string[]> {
  try {
    const args = since
      ? ['diff', '--name-only', since]
      : ['diff', '--name-only', 'HEAD'];

    const output = await runGitCommand(projectPath, args);

    // Include staged files
    const stagedOutput = await runGitCommand(projectPath, ['diff', '--name-only', '--cached']);

    const files = new Set<string>();

    output.split('\n').filter(Boolean).forEach(f => files.add(f));
    stagedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));

    return Array.from(files);
  } catch (error) {
    console.error('[GitTracker] getChangedFiles error:', error);
    return [];
  }
}

/**
 * Save pre-work snapshot (stash or commit hash)
 */
export async function takeSnapshot(projectPath: string): Promise<string> {
  try {
    // Return current HEAD commit hash
    const output = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
    return output.trim();
  } catch (error) {
    console.error('[GitTracker] takeSnapshot error:', error);
    return '';
  }
}

/**
 * Get files changed since snapshot
 */
export async function getChangedFilesSinceSnapshot(
  projectPath: string,
  snapshotHash: string
): Promise<string[]> {
  if (!snapshotHash) return [];

  try {
    // Committed changes
    const committedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only', snapshotHash, 'HEAD'
    ]);

    // Uncommitted changes (staged + unstaged)
    const uncommittedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only'
    ]);
    const stagedOutput = await runGitCommand(projectPath, [
      'diff', '--name-only', '--cached'
    ]);
    // Untracked new files — `git diff` only reports tracked files, so a worker
    // that CREATES a new file (e.g. a verification script) is invisible to the
    // reviewer, which then rejects with "no verification file / untracked"
    // forever. This blocks every new-file task (INT-1616 looped on exactly this).
    const untrackedOutput = await runGitCommand(projectPath, [
      'ls-files', '--others', '--exclude-standard'
    ]);

    const files = new Set<string>();

    committedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    uncommittedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    stagedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    untrackedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));

    // Exclude OpenSwarm's own worktree metadata EVERYWHERE (not just untracked):
    // .openswarm/* (repo-snapshot.json, repo.graphql) can be tracked/committed too,
    // and it's never the worker's work. Including it made the reviewer see "only
    // .openswarm metadata changed" and reject — and inflated filesChanged so a
    // no-edit run looked like a real change (INT-1630).
    const isMeta = (f: string) => f === '.openswarm' || f.startsWith('.openswarm/');
    return Array.from(files).filter((f) => !isMeta(f));
  } catch (error) {
    console.error('[GitTracker] getChangedFilesSinceSnapshot error:', error);
    return [];
  }
}

/**
 * Auto-commit with attribution
 */
export async function autoCommit(
  projectPath: string,
  message: string,
  model: string = 'claude'
): Promise<{ success: boolean; hash?: string; error?: string }> {
  try {
    // 1. Stage all changes (excluding build/test artifacts + OpenSwarm metadata)
    await stageWorkExcludingArtifacts(projectPath);

    // 2. Check if there are changes to commit
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    if (!status.trim()) {
      return { success: true, hash: undefined }; // Nothing to commit
    }

    // 3. Commit with Co-Authored-By
    const fullMessage = `${message}\n\nCo-Authored-By: ${model} <noreply@anthropic.com>`;
    await runGitCommand(projectPath, ['commit', '-m', fullMessage]);

    // 4. Get commit hash
    const hash = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

    return { success: true, hash: hash.trim() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Git command execution utility
 */
function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Check if project is a git repository
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await runGitCommand(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check dirty state (uncommitted changes)
 */
export async function isDirty(projectPath: string): Promise<boolean> {
  try {
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}
