// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Resolve the base remote + default branch to branch worktrees and PRs from.
 * OpenSwarm hardcoded `origin/main` everywhere, which silently broke every repo that
 * doesn't match BOTH assumptions: a repo whose default branch is `master`
 * (pykiwoom-rest, ArtifactNet) died at `git worktree add … origin/main` with
 * `fatal: invalid reference: origin/main` → creation failed → the issue could NEVER be
 * worked; a repo whose remote isn't named `origin` (vega-agent uses `unohee`) failed
 * the same way. Prefer the remote's own HEAD (`<remote>/HEAD`), fall back to main then
 * master. Works from a repo path or a worktree path (both share the repo's refs).
 * (INT-2545)
 */
export async function resolveBaseRef(gitDir: string): Promise<{ remote: string; branch: string; ref: string }> {
  const remotes = (await git(gitDir, 'remote').catch(() => ''))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] || 'origin');
  let branch = '';
  try {
    const head = (await git(gitDir, 'symbolic-ref', `refs/remotes/${remote}/HEAD`)).trim();
    branch = head.replace(`refs/remotes/${remote}/`, '');
  } catch { /* <remote>/HEAD not set locally — fall through to probing */ }
  if (!branch) {
    for (const cand of ['main', 'master']) {
      if (await git(gitDir, 'rev-parse', '--verify', `${remote}/${cand}`).then(() => true).catch(() => false)) {
        branch = cand;
        break;
      }
    }
  }
  if (!branch) branch = 'main'; // last resort — a bare repo with no fetched default
  return { remote, branch, ref: `${remote}/${branch}` };
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
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
  // The resume marker is the ONLY thing that protects this tree from the next
  // createWorktree() recreate (which deletes the branch + worktree, ~L286/L299) and
  // the heartbeat orphan-sweep (pruneWorktrees drops marker-less trees). So if we
  // can't write it, we CANNOT honestly claim the work is preserved. Two rules here:
  //   1. Never throw. An unguarded writeFileSync threw ENOSPC straight through
  //      executePipeline and crashed the whole daemon under a full disk (observed
  //      live: disk 100% → runner crash-loop). (INT-2521)
  //   2. Don't lie. Best-effort remove the tree to reclaim space — which is exactly
  //      what helps when the disk is full — and report NOT preserved. ENOSPC is an
  //      infra error, so the task retries fresh from origin/main once space frees.
  const markerPath = join(worktreePath, PRESERVE_MARKER);
  try {
    writeFileSync(
      markerPath,
      JSON.stringify({ issueId: info.issueId, branchName: info.branchName, reason, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.warn(`[Worktree] Preserve-marker write failed — cannot preserve, reclaiming space: ${worktreePath}`, err instanceof Error ? err.message : err);
    // A failed write can leave a truncated marker behind. Drop it first so a later
    // createWorktree()/prune doesn't treat the corpse as a real preserved tree, THEN
    // best-effort remove the whole worktree to reclaim space. Both are best-effort —
    // neither may throw (that is the very crash this guard exists to prevent).
    try { rmSync(markerPath, { force: true }); } catch { /* read-only/ENOSPC — leave it; prune treats an unreadable marker as sweepable */ }
    await removeWorktree(info).catch((e) => console.warn(`[Worktree] Cleanup after failed preserve also failed: ${worktreePath}`, e instanceof Error ? e.message : e));
    return false;
  }
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
    // A broken worktree .git pointer can make `worktree remove` fail while its
    // admin entry remains registered. Prune after the direct-removal fallback
    // so the old branch is no longer considered in use and retry can recreate it.
    await git(repoPath, 'worktree', 'prune').catch((e) =>
      console.warn(`[Worktree] Failed to prune stale worktree metadata: ${worktreePath}`, e)
    );
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

  // Resolve the repo's real base ref (remote + default branch) — NOT hardcoded
  // origin/main, which fataled on master-default / non-origin repos and blocked every
  // task in them. (INT-2545)
  const base = await resolveBaseRef(repoPath);
  await git(repoPath, 'fetch', base.remote, base.branch).catch((e) =>
    console.warn(`[Worktree] Failed to fetch ${base.ref}:`, e)
  );

  // Create fresh worktree from the resolved base ref
  await git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, base.ref);
  console.log(`[Worktree] Created: ${worktreePath} (branch: ${branchName}, base: ${base.ref})`);

  // Share the original repo's gitignored deps/data into the fresh worktree so the
  // worker can actually install / run tests / verify against real data. (INT-2415)
  await linkSharedPaths(repoPath, worktreePath);

  // Self-heal a broken LFS smudge in the fresh checkout. A failed smudge is what
  // pushes a worker to bypass the clean filter (`-c filter.lfs.clean=`) when `git
  // status` errors on it — the actual trigger for the filter-bypass corruption
  // guardLfsFilterCorruption defends against below. (INT-2430)
  await ensureLfsSmudged(worktreePath);

  return { worktreePath, branchName, originalPath: repoPath, issueId };
}

/** True if the worktree's .gitattributes declares any LFS-filtered path. */
function repoUsesLfs(worktreePath: string): boolean {
  try {
    return /filter=lfs\b/.test(readFileSync(join(worktreePath, '.gitattributes'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Best-effort: re-pull LFS objects so tracked files are real content on disk, not
 * literal pointer text (a failed/partial smudge). No-op (swallowed) for repos that
 * don't use LFS or when git-lfs isn't installed. (INT-2430)
 */
async function ensureLfsSmudged(worktreePath: string): Promise<void> {
  if (!repoUsesLfs(worktreePath)) return;
  await git(worktreePath, 'lfs', 'pull').catch((e) =>
    console.warn(`[Worktree] git lfs pull self-heal failed (non-fatal): ${worktreePath}`, e instanceof Error ? e.message : e),
  );
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

export interface OpenPRFileOverlap extends FileOverlap {
  number: number;
  url: string;
}

/**
 * Check planned files before a worker branch is created. This is intentionally
 * fail-open when GitHub is unavailable, but a successful query lets the runner
 * avoid producing another divergent implementation of the same files.
 */
export async function findOpenPRFileOverlaps(
  repoPath: string,
  plannedFiles: string[],
): Promise<OpenPRFileOverlap[]> {
  if (plannedFiles.length === 0) return [];
  const planned = new Set(plannedFiles.map((f) => f.replace(/^\.\//, '')));
  try {
    // `files` is available on `gh pr list --json`; fetch every scope in one API
    // request instead of running an unbounded `gh pr diff` loop.
    // gh paginates internally up to the requested limit. 1,000 is a deliberate
    // safety ceiling well above GitHub's practical open-PR queue sizes while
    // keeping one bounded request and covering the former 100-PR blind spot.
    const raw = await gh(repoPath, 'pr', 'list', '--state', 'open', '--json', 'number,url,headRefName,files', '--limit', '1000');
    const prs: { number: number; url: string; headRefName: string; files?: { path: string }[] }[] = JSON.parse(raw || '[]');
    const overlaps: OpenPRFileOverlap[] = [];
    for (const pr of prs) {
      const shared = (pr.files ?? []).map((f) => f.path).filter((f) => planned.has(f.replace(/^\.\//, '')));
      if (shared.length > 0) overlaps.push({ number: pr.number, url: pr.url, label: `PR #${pr.number} (${pr.headRefName})`, files: shared });
    }
    return overlaps;
  } catch (err) {
    console.warn('[Worktree] Preflight open-PR overlap check skipped:', err);
    return [];
  }
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

// Unsafe binary staging guard (INT-2430)
//
// When a worker hits a permission error running `git status` on an LFS-tracked
// repo, it can work around it with `-c filter.lfs.clean= -c filter.lfs.smudge=`.
// That makes every already-smudged LFS binary (real content on disk) look
// "modified" against its pointer, and the worker mistakes them for its own
// changes — the subsequent `git add -A` (worker's or ours, right before commit)
// stages them for real. An automated code-change commit has no legitimate reason
// to touch a data dump, so these extensions are excluded outright regardless of
// *why* they ended up staged. Real incident: PR #213/STONKS committed
// nas_data/fnguide/*.duckdb and models/validated_features/*.parquet this way —
// reverted by hand.
const UNSAFE_BINARY_DATA_RE = /\.(duckdb|parquet|pkl|pt)$/i;

/** Unstage any staged file matching an unsafe binary-data extension so it can
 *  never reach the commit. Best-effort — a failed unstage is logged, not thrown,
 *  since letting the binary through would be strictly worse. */
async function guardUnsafeBinaryStaging(worktreePath: string): Promise<void> {
  const staged = toLines(await git(worktreePath, 'diff', '--cached', '--name-only').catch(() => ''));
  const unsafe = staged.filter((f) => UNSAFE_BINARY_DATA_RE.test(f));
  if (unsafe.length === 0) return;

  console.warn(
    `[Worktree] Unstaging ${unsafe.length} binary data file(s) matching .duckdb/.parquet/.pkl/.pt — ` +
    `automated commits never intentionally touch these (INT-2430): ${unsafe.join(', ')}`,
  );
  for (const file of unsafe) {
    await git(worktreePath, 'reset', 'HEAD', '--', file).catch((e) =>
      console.warn(`[Worktree] Failed to unstage ${file}:`, e),
    );
  }
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
    const base = await resolveBaseRef(worktreePath);
    const branches = toLines(await git(worktreePath, 'branch', '-r', '--list', `${base.remote}/swarm/*`))
      .map(b => b.replace(new RegExp(`^${base.remote}/`), ''));
    for (const b of branches) {
      if (b === selfBranch || prBranches.has(b)) continue;
      try {
        const files = toLines(await git(worktreePath, 'diff', '--name-only', `${base.ref}...${base.remote}/${b}`));
        if (files.length) scopes.push({ label: `branch ${base.remote}/${b}`, files });
      } catch { /* skip this branch */ }
    }
  } catch { /* git unavailable — skip branch scopes */ }

  // Recently-merged PRs whose fix this branch's history does NOT contain —
  // if it also touches the same files, this branch likely forked before that
  // fix landed and would silently reintroduce it. Real incident: STONKS PR #218
  // called itself a "follow-up" to #215, but #218 had branched before #215
  // merged and never picked up its fix. (INT-2421)
  try {
    const raw = await gh(worktreePath, 'pr', 'list', '--state', 'merged', '--json', 'number,headRefName,mergeCommit', '--limit', '30');
    const merged: { number: number; headRefName: string; mergeCommit?: { oid: string } }[] = JSON.parse(raw || '[]');
    for (const pr of merged) {
      if (pr.headRefName === selfBranch || !pr.mergeCommit?.oid) continue;
      const alreadyIncluded = await git(worktreePath, 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'HEAD')
        .then(() => true).catch(() => false);
      if (alreadyIncluded) continue;
      try {
        const files = toLines(await gh(worktreePath, 'pr', 'diff', String(pr.number), '--name-only'));
        if (files.length) {
          scopes.push({
            label: `⚠️ MERGED PR #${pr.number} (${pr.headRefName}) — not in this branch's history, verify its fix wasn't dropped`,
            files,
          });
        }
      } catch { /* skip this merged PR */ }
    }
  } catch { /* gh unavailable — skip merged-PR staleness check */ }

  return scopes;
}

// Duplicate-issue-PR guard (INT-2544)
//
// Two parallel workers can each independently implement the same Linear issue on
// their own branch and both open PRs — nothing checked whether one already exists.
// Real incident: STONKS STO-1400 (PR #224 merged + PR #226 left open, CONFLICTING)
// and STO-1454 (PR #221 merged + PR #228 left open, CONFLICTING) sat undetected
// until a human noticed the "File overlap with in-flight work" comment and ran
// `git merge-tree` by hand. Every OpenSwarm PR body literally contains
// `Closes <issueIdentifier>`, so a GitHub body search finds siblings regardless of
// branch name or merge state.

/** Other PRs (any state) whose body already closes this Linear issue, excluding
 *  this branch's own PR. Best-effort — any gh failure returns [] rather than
 *  blocking PR creation. */
async function findDuplicateIssuePRs(
  worktreePath: string,
  issueIdentifier: string,
  selfBranch: string,
): Promise<{ number: number; url: string; headRefName: string }[]> {
  try {
    const raw = await gh(
      worktreePath, 'pr', 'list',
      '--search', `"Closes ${issueIdentifier}" in:body`,
      '--state', 'all',
      '--json', 'number,url,headRefName',
      '--limit', '10',
    );
    const prs: { number: number; url: string; headRefName: string }[] = JSON.parse(raw || '[]');
    return prs.filter((pr) => pr.headRefName !== selfBranch);
  } catch (err) {
    console.warn('[Worktree] Duplicate-issue-PR check skipped:', err);
    return [];
  }
}

/** Render the duplicate-PR warning as a PR-body markdown section ('' if none). */
function formatDuplicateIssueSection(issueIdentifier: string, duplicates: { number: number; url: string; headRefName: string }[]): string {
  if (duplicates.length === 0) return '';
  return [
    '## ⚠️ Possible duplicate work',
    '',
    `${duplicates.length} other PR(s) already reference \`Closes ${issueIdentifier}\` — opened as a draft. Verify this isn't redundant with already-merged work before marking ready and merging:`,
    '',
    ...duplicates.map((d) => `- ${d.url} (${d.headRefName})`),
  ].join('\n');
}

/**
 * Build the PR-body overlap section for this worktree branch. Returns '' when
 * there is no overlap or on any error (advisory — must not block PR creation).
 */
async function buildFileOverlapSection(worktreePath: string, selfBranch: string): Promise<string> {
  try {
    const base = await resolveBaseRef(worktreePath);
    const selfFiles = toLines(await git(worktreePath, 'diff', '--name-only', `${base.ref}...HEAD`));
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
    await guardUnsafeBinaryStaging(worktreePath); // INT-2430

    const stillStaged = await git(worktreePath, 'diff', '--cached', '--name-only');
    if (stillStaged.trim()) {
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
    } else {
      console.log(`[Worktree] Nothing left to commit after unsafe-binary-staging guard stripped all staged changes (${branchName})`);
    }
  }

  // Check if there are any commits ahead of the base ref (including worker-made
  // commits) — resolved, not hardcoded origin/main (INT-2545).
  const base = await resolveBaseRef(worktreePath);
  const commitsAhead = await git(worktreePath, 'rev-list', '--count', `${base.ref}..HEAD`)
    .then((out) => parseInt(out.trim(), 10))
    .catch(() => 0);

  if (commitsAhead === 0) {
    console.log(`[Worktree] No commits ahead of ${base.ref} (${branchName}) - nothing to PR`);
    throw new Error(`No commits to create PR from - branch has no changes compared to ${base.branch}`);
  }

  console.log(`[Worktree] Branch ${branchName} has ${commitsAhead} commit(s) ahead of ${base.ref}`);

  // Push branch to the resolved remote (always push since we have commits ahead)
  await git(worktreePath, 'push', '-u', base.remote, branchName, '--force-with-lease');
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

  // Another branch may already close this same Linear issue (INT-2544) — never
  // block on it (the work is done and worth keeping visible), but never let it
  // silently masquerade as the sole implementation either: open as draft.
  const duplicates = await findDuplicateIssuePRs(worktreePath, issueIdentifier, branchName);
  const duplicateSection = formatDuplicateIssueSection(issueIdentifier, duplicates);
  if (duplicates.length > 0) {
    console.warn(
      `[Worktree] ${duplicates.length} other PR(s) already close ${issueIdentifier} — opening as draft: ` +
      duplicates.map((d) => d.url).join(', '),
    );
  }

  // Create PR
  const prBody = [
    '## Summary',
    description || `${issueIdentifier}: ${title}`,
    ...(overlapSection ? ['', overlapSection] : []),
    ...(duplicateSection ? ['', duplicateSection] : []),
    '',
    '## Linear',
    `Closes ${issueIdentifier}`,
    '',
    '---',
    '🤖 Generated with [OpenSwarm](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  const createArgs = ['pr', 'create', '--head', branchName, '--base', base.branch, '--title', title, '--body', prBody];
  if (duplicates.length > 0) createArgs.push('--draft');
  const prUrl = await gh(worktreePath, ...createArgs);

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
