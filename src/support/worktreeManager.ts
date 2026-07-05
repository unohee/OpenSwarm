// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { registerOwnedPR } from '../automation/prOwnership.js';
import { runConventionalCommitGuard } from '../agents/pipelineGuards.js';
import { loadRepoMetadata } from './repoMetadata.js';

const execFileAsync = promisify(execFile);

/** Wall-clock ceiling for a single git invocation (fetch/push/clone included).
 *  Without it a stalled network git op hangs the whole task before the pipeline's
 *  own timeouts can engage. A timed-out git rejects with ETIMEDOUT/"timed out",
 *  which isInfraError classifies → infra_error backoff, not STUCK. (INT-2521) */
const GIT_TIMEOUT_MS = 5 * 60_000;

/** Safe git command execution (no shell), bounded by GIT_TIMEOUT_MS. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Safe gh command execution (no shell). `cwd` must be inside the target repo —
 * gh infers the repository from the working directory, and the daemon's own
 * cwd is typically NOT a git repo (e.g. started from $HOME), which made every
 * `gh pr create` here die with "fatal: not a git repository" while the push
 * (which does pass a cwd) succeeded — completed work stranded on remote
 * branches with no PR. (INT-2321)
 */
async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout;
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

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function worktreeRoot(repoPath: string): string {
  return resolve(repoPath, 'worktree');
}

function resolveWorktreePath(repoPath: string, issueId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(issueId) || issueId === '.' || issueId === '..') {
    throw new Error(`Invalid worktree issueId path segment: ${issueId}`);
  }

  const root = worktreeRoot(repoPath);
  const path = resolve(join(root, issueId));
  if (!isPathInside(root, path)) {
    throw new Error(`Resolved worktree path escapes ${root}: ${path}`);
  }
  return path;
}

function assertManagedWorktreePath(repoPath: string, worktreePath: string): string {
  const root = worktreeRoot(repoPath);
  const path = resolve(worktreePath);
  if (!isPathInside(root, path)) {
    throw new Error(`Refusing to remove unmanaged worktree path: ${path}`);
  }
  return path;
}

// Shared deps/data linking (INT-2415)
//
// A worktree is created fresh from origin/main, so it has NO node_modules / .venv
// and none of the repo's gitignored real data (db/*.db etc.) — a worker there
// physically cannot run npm/pytest/playwright or real-data verification. We keep
// the worktree isolating CODE, but SHARE the original repo's gitignored deps/data
// into it via symlink. The original repo is itself the installed sandbox, and
// deps/DBs are read-mostly, so parallel workers sharing them is safe.

/** Always-gitignored dependency dirs safe to auto-link without a config. */
const AUTO_SHARED_CANDIDATES = ['node_modules', '.venv', 'venv'];

interface SandboxConfig {
  sandbox?: { sharedPaths?: string[] } | null;
}

/**
 * Pure decision: which repo-relative paths should be symlinked into a worktree.
 *
 * - If openswarm.json declares `sandbox.sharedPaths`, trust that list verbatim
 *   (the repo owner opted in — no gitignore check).
 * - Otherwise auto-detect only the always-gitignored dependency dirs
 *   (node_modules/.venv/venv); never a tracked dir.
 *
 * Returns only candidates that actually EXIST at `<repoPath>/<P>` (read-only
 * check). Absolute or parent-escaping (`..`) entries are dropped for safety.
 * The symlink creation itself is the caller's side effect. (INT-2415)
 */
export function resolveSharedPaths(repoPath: string, openswarmJson?: SandboxConfig | null): string[] {
  const configured = openswarmJson?.sandbox?.sharedPaths;
  const candidates = configured && configured.length > 0 ? configured : AUTO_SHARED_CANDIDATES;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) continue; // never escape the repo
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(join(repoPath, p))) out.push(p);
  }
  return out;
}

/**
 * Symlink the original repo's shared gitignored deps/data into a fresh worktree.
 * Best-effort and idempotent: skips paths already present in the worktree (never
 * clobbers a checked-out tracked dir) and swallows per-link failures (a failed
 * symlink degrades to today's no-deps behavior, never breaks worktree creation).
 */
async function linkSharedPaths(repoPath: string, worktreePath: string): Promise<void> {
  let meta: SandboxConfig | null = null;
  try {
    meta = await loadRepoMetadata(repoPath);
  } catch (err) {
    // Malformed openswarm.json must not break worktree creation. (INT-2415)
    console.warn(`[Worktree] openswarm.json unreadable; skipping sharedPaths config:`, err);
  }

  for (const rel of resolveSharedPaths(repoPath, meta)) {
    const target = join(repoPath, rel); // absolute source so the link survives any cwd
    const linkPath = join(worktreePath, rel);
    try {
      if (existsSync(linkPath)) continue; // tracked dir already checked out — do not clobber
      mkdirSync(dirname(linkPath), { recursive: true }); // support nested sharedPaths (e.g. db/x.db)
      symlinkSync(target, linkPath);
      console.log(`[Worktree] Linked shared path: ${rel} -> ${target}`);
    } catch (err) {
      console.warn(`[Worktree] Failed to link shared path ${rel}:`, err);
    }
  }
}

// Worktree Lifecycle

/** Create git worktree + checkout branch */
/**
 * Marker dropped into a failed session's worktree so its partial implementation
 * survives cleanup and the retry RESUMES from it instead of re-implementing from
 * scratch (INT-2503). pruneWorktrees skips marked dirs; createWorktree reuses
 * them; a successful run still removes the worktree as before.
 */
const PRESERVE_MARKER = '.openswarm-preserved';
/** Preserved trees older than this are abandoned (task STUCK or issue closed) — swept. */
const PRESERVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function preserveMarkerAgeMs(worktreePath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(worktreePath, PRESERVE_MARKER), 'utf8')) as { at?: string };
    const at = raw.at ? Date.parse(raw.at) : NaN;
    return Number.isFinite(at) ? Date.now() - at : null;
  } catch {
    return null; // unreadable marker → treat as expired (swept)
  }
}

/**
 * Discard a preserved worktree, keeping the partial work reachable: best-effort
 * commit it onto the tree's swarm branch (survives worktree removal, human can
 * inspect), then remove the directory. Used when a task goes terminally STUCK
 * and by the age sweep. Accepts the worktree path itself — the repo root is the
 * segment before `/worktree/<id>`. No-op for paths that don't match. (INT-2506)
 */
export async function removePreservedWorktreeAt(worktreePath: string): Promise<void> {
  const m = worktreePath.replace(/\/+$/, '').match(/^(.*)\/worktree\/[^/]+$/);
  if (!m || !existsSync(worktreePath)) return;
  const repoRoot = m[1];
  try {
    await git(worktreePath, 'add', '-A');
    await git(
      worktreePath,
      '-c', 'user.email=swarm@openswarm.local', '-c', 'user.name=OpenSwarm',
      'commit', '--no-verify', '-m', 'wip: preserved partial work (auto, pre-cleanup)',
    );
    console.log(`[Worktree] WIP committed to branch before cleanup: ${worktreePath}`);
  } catch { /* clean tree or commit failure — proceed with removal */ }
  await git(repoRoot, 'worktree', 'remove', '--force', worktreePath).catch(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });
  console.log(`[Worktree] Removed preserved worktree: ${worktreePath}`);
}

/**
 * Preserve a failed session's worktree when it holds actual work: drop the
 * marker and leave the tree in place. A clean tree has nothing worth keeping —
 * remove it as before. Returns true when preserved.
 */
export async function preserveWorktree(info: WorktreeInfo, reason: string): Promise<boolean> {
  const worktreePath = assertManagedWorktreePath(info.originalPath, info.worktreePath);
  // Distinguish a genuinely clean tree from a git-status FAILURE (index/ref lock
  // under parallel load, transient corruption). The old `.catch(() => '')` treated
  // an error as "clean" → removeWorktree DELETED trees that may hold real partial
  // work whenever git merely errored, defeating the preserve-for-resume guarantee.
  // On any doubt, PRESERVE — never delete unconfirmed work. (INT-2521)
  let dirty: string | null;
  try {
    dirty = await git(worktreePath, 'status', '--porcelain');
  } catch (err) {
    if (!existsSync(worktreePath)) return false; // tree gone — nothing to preserve or remove
    console.warn(`[Worktree] git status failed — preserving the tree to be safe: ${worktreePath}`, err instanceof Error ? err.message : err);
    dirty = null;
  }
  if (dirty !== null && !dirty.trim()) {
    await removeWorktree(info);
    return false;
  }
  const fileCount = dirty === null ? 0 : dirty.split('\n').filter(Boolean).length;
  writeFileSync(
    join(worktreePath, PRESERVE_MARKER),
    JSON.stringify({ issueId: info.issueId, branchName: info.branchName, reason, at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  const label = dirty === null ? 'git status unavailable — preserved to be safe' : `${fileCount} dirty files`;
  console.log(`[Worktree] Preserved for retry (${label}, ${reason}): ${worktreePath}`);
  return true;
}

export async function createWorktree(
  repoPath: string,
  issueId: string,
  branchName: string,
): Promise<WorktreeInfo> {
  const worktreePath = resolveWorktreePath(repoPath, issueId);

  // Retry of a preserved failure: RESUME from the previous attempt's partial
  // work (and its build caches) instead of wiping it (INT-2503). Consume the
  // marker — if this attempt fails again it gets re-preserved by the runner.
  if (existsSync(worktreePath) && existsSync(join(worktreePath, PRESERVE_MARKER))) {
    const valid = await git(worktreePath, 'status', '--porcelain').then(() => true).catch(() => false);
    const branch = await git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').then((b) => b.trim()).catch(() => '');
    if (valid && branch === branchName) {
      rmSync(join(worktreePath, PRESERVE_MARKER), { force: true });
      console.log(`[Worktree] Resuming preserved worktree: ${worktreePath} (branch: ${branchName})`);
      return { worktreePath, branchName, originalPath: repoPath, issueId };
    }
    console.warn(`[Worktree] Preserved worktree invalid (valid=${valid}, branch=${branch}) — recreating: ${worktreePath}`);
  }

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

  // Share the original repo's gitignored deps/data into the fresh worktree so the
  // worker can actually install / run tests / verify against real data. (INT-2415)
  await linkSharedPaths(repoPath, worktreePath);

  return { worktreePath, branchName, originalPath: repoPath, issueId };
}

// File-overlap report (INT-2388 defect #3 / INT-2392)
//
// Parallel swarm branches don't see each other's changes, so two efforts edit
// the same files and diverge (self-demonstrated on INT-2388). When a PR is
// created, surface which open PRs / active swarm/* branches touch the same
// files — advisory only, never blocks PR creation.

export interface BranchScope {
  /** Human label, e.g. "PR #206 (feat/int-2389-…)". */
  label: string;
  /** Files this scope changes relative to main. */
  files: string[];
}

export interface FileOverlap {
  label: string;
  files: string[];
}

/** Pure: intersect this branch's changed files with each other scope's files. */
export function computeFileOverlaps(selfFiles: string[], others: BranchScope[]): FileOverlap[] {
  const selfSet = new Set(selfFiles);
  const out: FileOverlap[] = [];
  for (const o of others) {
    const shared = o.files.filter(f => selfSet.has(f));
    if (shared.length > 0) out.push({ label: o.label, files: shared });
  }
  return out;
}

/** Pure: render overlaps as a PR-body markdown section (empty string if none). */
export function formatOverlapReport(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) return '';
  const lines = [
    '## ⚠️ File overlap with in-flight work',
    '',
    'This branch changes files that other open PRs / active branches also touch. Coordinate before merging to avoid divergent parallel edits (INT-2388 #3):',
    '',
  ];
  for (const o of overlaps) {
    const shown = o.files.slice(0, 8).map(f => `\`${f}\``).join(', ');
    const more = o.files.length > 8 ? ` (+${o.files.length - 8} more)` : '';
    lines.push(`- **${o.label}** — ${o.files.length} file(s): ${shown}${more}`);
  }
  return lines.join('\n');
}

/** Split git/gh newline output into a trimmed, non-empty list. */
function toLines(out: string): string[] {
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * Collect file scopes of open PRs and active swarm/* branches (excluding self).
 * Each source is independently guarded — a gh/git hiccup drops that source, not
 * the whole report.
 */
async function collectActiveScopes(worktreePath: string, selfBranch: string): Promise<BranchScope[]> {
  const scopes: BranchScope[] = [];
  const prBranches = new Set<string>();

  // Open PRs (exclude self).
  try {
    const raw = await gh(worktreePath, 'pr', 'list', '--state', 'open', '--json', 'number,headRefName', '--limit', '50');
    const prs: { number: number; headRefName: string }[] = JSON.parse(raw || '[]');
    for (const pr of prs) {
      prBranches.add(pr.headRefName);
      if (pr.headRefName === selfBranch) continue;
      try {
        const files = toLines(await gh(worktreePath, 'pr', 'diff', String(pr.number), '--name-only'));
        if (files.length) scopes.push({ label: `PR #${pr.number} (${pr.headRefName})`, files });
      } catch { /* skip this PR */ }
    }
  } catch { /* gh unavailable — skip PR scopes */ }

  // Active swarm/* branches without their own PR yet (exclude self + PR'd branches).
  try {
    const branches = toLines(await git(worktreePath, 'branch', '-r', '--list', 'origin/swarm/*'))
      .map(b => b.replace(/^origin\//, ''));
    for (const b of branches) {
      if (b === selfBranch || prBranches.has(b)) continue;
      try {
        const files = toLines(await git(worktreePath, 'diff', '--name-only', `origin/main...origin/${b}`));
        if (files.length) scopes.push({ label: `branch origin/${b}`, files });
      } catch { /* skip this branch */ }
    }
  } catch { /* git unavailable — skip branch scopes */ }

  return scopes;
}

/**
 * Build the PR-body overlap section for this worktree branch. Returns '' when
 * there is no overlap or on any error (advisory — must not block PR creation).
 */
async function buildFileOverlapSection(worktreePath: string, selfBranch: string): Promise<string> {
  try {
    const selfFiles = toLines(await git(worktreePath, 'diff', '--name-only', 'origin/main...HEAD'));
    if (selfFiles.length === 0) return '';
    const others = await collectActiveScopes(worktreePath, selfBranch);
    return formatOverlapReport(computeFileOverlaps(selfFiles, others));
  } catch (err) {
    console.warn('[Worktree] File-overlap report skipped:', err);
    return '';
  }
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

  // Compute file overlap vs other in-flight work (advisory; never blocks). (INT-2392)
  const overlapSection = await buildFileOverlapSection(worktreePath, branchName);

  // Create PR
  const prBody = [
    '## Summary',
    description || `${issueIdentifier}: ${title}`,
    ...(overlapSection ? ['', overlapSection] : []),
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
  const worktreePath = assertManagedWorktreePath(info.originalPath, info.worktreePath);
  try {
    await git(info.originalPath, 'worktree', 'remove', '--force', worktreePath);
    console.log(`[Worktree] Removed: ${worktreePath}`);
  } catch {
    // fallback: direct removal
    rmSync(worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Force removed: ${worktreePath}`);
  }
}

/** Clean up dangling worktrees.
 *
 * `git worktree prune` only drops metadata for worktrees whose directory is already gone. A
 * daemon that was hard-killed or crashed mid-run never ran the `finally` cleanup, so its
 * `{repo}/worktree/<issueId>` directories survive as orphans (INT-1810 R4). On start nothing
 * is in flight, so force-remove every one of our own worktree dirs.
 *
 * `activeWorktreePaths` are the worktrees of currently-running tasks — never swept. Pass an
 * empty set at startup (remove all); pass the live set when sweeping per-heartbeat so an
 * in-flight task's worktree is preserved. */
export async function pruneWorktrees(repoPath: string, activeWorktreePaths: Set<string> = new Set()): Promise<void> {
  await git(repoPath, 'worktree', 'prune').catch((e) => console.warn(`[Worktree] Prune failed for ${repoPath}:`, e));
  try {
    const out = await git(repoPath, 'worktree', 'list', '--porcelain');
    const prefix = `${repoPath}/worktree/`;
    const candidates = out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => p.startsWith(prefix))
      .filter((p) => !activeWorktreePaths.has(p)); // keep worktrees of running tasks
    for (const p of candidates) {
      // Preserved failed-session worktrees carry the retry's partial work — they
      // survive restarts and sweeps (INT-2503) until they age out (abandoned:
      // task went STUCK or the issue was closed). Expired ones get their work
      // committed to the branch, then removed (INT-2506).
      if (existsSync(join(p, PRESERVE_MARKER))) {
        const age = preserveMarkerAgeMs(p);
        if (age !== null && age <= PRESERVE_MAX_AGE_MS) continue; // still fresh — keep
        console.log(`[Worktree] Preserved worktree expired (${age === null ? 'unreadable marker' : Math.round(age / 3_600_000) + 'h'}) — sweeping: ${p}`);
        await removePreservedWorktreeAt(p).catch((e) => console.warn(`[Worktree] Expired-preserve sweep failed for ${p}:`, e));
        continue;
      }
      await git(repoPath, 'worktree', 'remove', '--force', p)
        .then(() => console.log(`[Worktree] Swept orphan worktree: ${p}`))
        .catch((e) => console.warn(`[Worktree] Orphan sweep failed for ${p}:`, e));
    }
  } catch (e) {
    console.warn(`[Worktree] Orphan sweep skipped for ${repoPath}:`, e);
  }
  console.log(`[Worktree] Pruned stale worktrees for: ${repoPath}`);
}
