// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

export interface WorktreeInfo {
  /** /tmp/swarm-worktrees/{issueId} */
  worktreePath: string;
  /** swarm/INT-XXX-slug */
  branchName: string;
  /** Original repository path */
  originalPath: string;
  issueId: string;
}

// ============================================
// Branch & Path Utilities
// ============================================

/** Generate branch name: swarm/INT-512-llm-tool-interface */
export function buildBranchName(issueIdentifier: string, title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `swarm/${issueIdentifier}-${slug}`;
}

// ============================================
// Worktree Lifecycle
// ============================================

/** Create git worktree + checkout branch */
export async function createWorktree(
  repoPath: string,
  issueId: string,
  branchName: string,
): Promise<WorktreeInfo> {
  const worktreePath = `/tmp/swarm-worktrees/${issueId}`;

  // Clean up existing worktree (retry case)
  if (existsSync(worktreePath)) {
    await execAsync(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`).catch((e) => console.warn(`[Worktree] Failed to remove existing worktree: ${worktreePath}`, e));
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Check if branch exists
  const branchExists = await execAsync(`git -C "${repoPath}" branch --list "${branchName}"`)
    .then(({ stdout }) => stdout.trim().length > 0)
    .catch((e) => { console.warn(`[Worktree] Branch check failed for ${branchName}:`, e); return false; });

  const createCmd = branchExists
    ? `git -C "${repoPath}" worktree add "${worktreePath}" "${branchName}"`
    : `git -C "${repoPath}" worktree add -b "${branchName}" "${worktreePath}" HEAD`;

  await execAsync(createCmd);
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

  // Check for changes and commit
  const { stdout: status } = await execAsync(`git -C "${worktreePath}" status --porcelain`);
  if (status.trim()) {
    await execAsync(`git -C "${worktreePath}" add -A`);
    const commitMsg = [
      `feat(${issueIdentifier}): ${title.slice(0, 72)}`,
      '',
      '🤖 Generated with OpenSwarm (VEGA)',
      '',
      'Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>',
    ].join('\n');
    await execAsync(`git -C "${worktreePath}" commit -m ${JSON.stringify(commitMsg)}`);
  }

  // push
  await execAsync(`git -C "${worktreePath}" push -u origin "${branchName}" --force-with-lease`);

  // If PR already exists, just return the URL
  const { stdout: existing } = await execAsync(
    `gh pr list --head "${branchName}" --state open --json url --jq '.[0].url'`
  ).catch((e) => { console.warn(`[Worktree] PR list check failed for ${branchName}:`, e); return { stdout: '' }; });

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
    '🤖 Generated with [OpenSwarm (VEGA)](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  const { stdout: prUrl } = await execAsync(
    `gh pr create --head "${branchName}" --base main --title ${JSON.stringify(title)} --body ${JSON.stringify(prBody)}`
  );

  const url = prUrl.trim();
  console.log(`[Worktree] PR created: ${url}`);
  return url;
}

/** Clean up worktree */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await execAsync(`git -C "${info.originalPath}" worktree remove --force "${info.worktreePath}"`);
    console.log(`[Worktree] Removed: ${info.worktreePath}`);
  } catch {
    // fallback: direct removal
    rmSync(info.worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Force removed: ${info.worktreePath}`);
  }
}

/** Clean up dangling worktrees on service start */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await execAsync(`git -C "${repoPath}" worktree prune`).catch((e) => console.warn(`[Worktree] Prune failed for ${repoPath}:`, e));
  console.log(`[Worktree] Pruned stale worktrees for: ${repoPath}`);
}
