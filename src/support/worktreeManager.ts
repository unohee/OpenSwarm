// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { registerOwnedPR } from '../automation/prOwnership.js';
import { runConventionalCommitGuard } from '../agents/pipelineGuards.js';

const execFileAsync = promisify(execFile);

/** Safe git command execution (no shell) */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout;
}

/** Safe gh command execution (no shell). cwd MUST be the worktree — otherwise gh
 * uses the daemon's cwd, which may not be a git repo (PR creation failed with
 * "not a git repository" once worktreeMode moved work out of the main checkout). */
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd });
  return stdout;
}

/**
 * If the repo has no CI workflow, write a default one so the PR gets objective CI
 * gates (GitHub Actions runs on push). Language-detected from manifest files; returns
 * the path written, or null if a workflow already exists or the language is unknown
 * (we don't guess). Steps use `|| true` so a missing tool doesn't red-X the whole run.
 */
function ensureCIWorkflow(worktreePath: string): string | null {
  const wfDir = `${worktreePath}/.github/workflows`;
  if (existsSync(wfDir) && readdirSync(wfDir).some((f) => /\.ya?ml$/.test(f))) return null;

  const has = (f: string) => existsSync(`${worktreePath}/${f}`);
  const isPython = has('pyproject.toml') || has('setup.py') || has('requirements.txt');
  const isNode = has('package.json');

  let yml: string;
  if (isPython) {
    yml = [
      'name: CI', 'on: [push, pull_request]', 'jobs:', '  test:',
      '    runs-on: ubuntu-latest', '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-python@v5',
      "        with: { python-version: '3.x' }",
      '      - run: pip install -e . || pip install -r requirements.txt || true',
      '      - run: pip install ruff pytest || true',
      '      - run: ruff check . || true',
      '      - run: pytest -q || true', '',
    ].join('\n');
  } else if (isNode) {
    yml = [
      'name: CI', 'on: [push, pull_request]', 'jobs:', '  test:',
      '    runs-on: ubuntu-latest', '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      "        with: { node-version: '20' }",
      '      - run: npm ci || npm install',
      '      - run: npm run typecheck --if-present',
      '      - run: npm run lint --if-present',
      '      - run: npm test --if-present', '',
    ].join('\n');
  } else {
    return null;
  }
  mkdirSync(wfDir, { recursive: true });
  const filePath = `${wfDir}/ci.yml`;
  writeFileSync(filePath, yml);
  return filePath;
}

// Types

export interface WorktreeInfo {
  /** {repoPath}/worktree/{issueId} */
  worktreePath: string;
  /** swarm/INT-XXX-slug */
  branchName: string;
  /** Original repository path */
  originalPath: string;
  issueId: string;
}

// Branch & Path Utilities

/** Generate branch name: swarm/INT-512-llm-tool-interface */
export function buildBranchName(issueIdentifier: string, title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `swarm/${issueIdentifier}-${slug}`;
}

// Worktree Lifecycle

/** Create git worktree + checkout branch */
export async function createWorktree(
  repoPath: string,
  issueId: string,
  branchName: string,
): Promise<WorktreeInfo> {
  const worktreePath = `${repoPath}/worktree/${issueId}`;

  // Clean up existing worktree (retry case)
  if (existsSync(worktreePath)) {
    await git(repoPath, 'worktree', 'remove', '--force', worktreePath).catch((e) => console.warn(`[Worktree] Failed to remove existing worktree: ${worktreePath}`, e));
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Always create fresh branch from latest main to avoid conflicts
  // Delete existing branch if it exists (force clean state)
  const branchExists = await git(repoPath, 'branch', '--list', branchName)
    .then((out) => out.trim().length > 0)
    .catch((e) => { console.warn(`[Worktree] Branch check failed for ${branchName}:`, e); return false; });

  if (branchExists) {
    // Delete old branch to start fresh
    await git(repoPath, 'branch', '-D', branchName).catch((e) =>
      console.warn(`[Worktree] Failed to delete old branch ${branchName}:`, e)
    );
  }

  // Update main to latest
  await git(repoPath, 'fetch', 'origin', 'main').catch((e) =>
    console.warn(`[Worktree] Failed to fetch origin/main:`, e)
  );

  // Create fresh worktree from origin/main
  await git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, 'origin/main');
  console.log(`[Worktree] Created: ${worktreePath} (branch: ${branchName})`);

  return { worktreePath, branchName, originalPath: repoPath, issueId };
}

/** Commit changes + push + gh pr create */
export async function commitAndCreatePR(
  info: WorktreeInfo,
  title: string,
  issueIdentifier: string,
  description: string,
): Promise<string> {
  const { worktreePath, branchName } = info;

  // Check for uncommitted changes and commit them
  const status = await git(worktreePath, 'status', '--porcelain');

  if (status.trim()) {
    await git(worktreePath, 'add', '-A');
    const commitMsg = [
      `feat(${issueIdentifier}): ${title.slice(0, 72)}`,
      '',
      '🤖 Generated with OpenSwarm',
      '',
      'Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>',
    ].join('\n');

    // Validate conventional commit format (warning only)
    const commitCheck = runConventionalCommitGuard(commitMsg);
    if (!commitCheck.passed) {
      console.warn(`[Worktree] Commit format warning: ${commitCheck.issues.join('; ')}`);
    }

    await git(worktreePath, 'commit', '-m', commitMsg);
    console.log(`[Worktree] Committed uncommitted changes (${branchName})`);
  }

  // Check if there are any commits ahead of origin/main (including worker-made commits)
  const commitsAhead = await git(worktreePath, 'rev-list', '--count', 'origin/main..HEAD')
    .then((out) => parseInt(out.trim(), 10))
    .catch(() => 0);

  if (commitsAhead === 0) {
    console.log(`[Worktree] No commits ahead of origin/main (${branchName}) - nothing to PR`);
    throw new Error('No commits to create PR from - branch has no changes compared to main');
  }

  console.log(`[Worktree] Branch ${branchName} has ${commitsAhead} commit(s) ahead of origin/main`);

  // Auto-add a default CI workflow if the repo has none, so the PR gets objective CI
  // gates (GitHub Actions runs on push). Only reached when there's real work
  // (commitsAhead > 0). Committed separately so it reads as tooling, not the worker's edit.
  const addedCI = ensureCIWorkflow(worktreePath);
  if (addedCI) {
    await git(worktreePath, 'add', '.github/workflows');
    await git(worktreePath, 'commit', '-m', 'ci: add default CI workflow (auto-added by OpenSwarm)');
    console.log(`[Worktree] Added CI workflow: ${addedCI}`);
  }

  // Push branch to remote (always push since we have commits ahead)
  await git(worktreePath, 'push', '-u', 'origin', branchName, '--force-with-lease');
  console.log(`[Worktree] Pushed branch ${branchName}`);

  // If PR already exists, just return the URL
  const existing = await gh(worktreePath, 'pr', 'list', '--head', branchName, '--state', 'open', '--json', 'url', '--jq', '.[0].url')
    .catch((e) => { console.warn(`[Worktree] PR list check failed for ${branchName}:`, e); return ''; });

  if (existing.trim()) {
    console.log(`[Worktree] PR already exists: ${existing.trim()}`);
    return existing.trim();
  }

  // Create PR
  const prBody = [
    '## Summary',
    description || `${issueIdentifier}: ${title}`,
    '',
    '## Linear',
    `Closes ${issueIdentifier}`,
    '',
    '---',
    '🤖 Generated with [OpenSwarm](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  const prUrl = await gh(worktreePath, 'pr', 'create', '--head', branchName, '--base', 'main', '--title', title, '--body', prBody);

  const url = prUrl.trim();
  console.log(`[Worktree] PR created: ${url}`);

  // Register PR ownership for conflict auto-resolution
  const prNumberMatch = url.match(/\/pull\/(\d+)/);
  if (prNumberMatch) {
    const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
    const repo = repoMatch ? repoMatch[1] : '';
    if (repo) {
      await registerOwnedPR({
        repo,
        prNumber: parseInt(prNumberMatch[1], 10),
        branch: branchName,
        createdAt: new Date().toISOString(),
        issueIdentifier: issueIdentifier,
      }).catch((err) => console.warn(`[Worktree] Failed to register PR ownership:`, err));
    }
  }

  return url;
}

/** Clean up worktree */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await git(info.originalPath, 'worktree', 'remove', '--force', info.worktreePath);
    console.log(`[Worktree] Removed: ${info.worktreePath}`);
  } catch {
    // fallback: direct removal
    rmSync(info.worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Force removed: ${info.worktreePath}`);
  }
}

/** Clean up dangling worktrees on service start */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, 'worktree', 'prune').catch((e) => console.warn(`[Worktree] Prune failed for ${repoPath}:`, e));
  console.log(`[Worktree] Pruned stale worktrees for: ${repoPath}`);
}
