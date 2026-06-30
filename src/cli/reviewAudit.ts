// ============================================
// OpenSwarm - `openswarm review --max` codebase audit (INT-2006)
// ============================================
//
// Full-codebase, multi-agent audit. Partition the tracked source into
// directory-shaped "areas", fan a reviewer subagent out over each area with a
// concurrency cap, then aggregate the verdicts. The pure pieces (filter /
// partition / aggregate) are unit-tested; the orchestration shell wires
// git + runReviewer + the live board + Linear.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { ReviewResult, RecommendedAction } from '../agents/agentPair.js';
import type { AdapterName } from '../adapters/types.js';
import { runPool } from '../support/concurrencyPool.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// Source extensions and test patterns mirror src/knowledge/scanner.ts. Kept
// local (not imported) because those are unexported module consts; the audit
// only needs the stable subset and drift here is low-risk.
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw']);
const TEST_PATTERNS = [/\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, /_test\.py$/, /test_.*\.py$/, /\.test\.py$/];
// Belt-and-suspenders: git ls-files already honors .gitignore, but tracked
// junk dirs (snapshots, coverage) shouldn't be audited as if they were source.
const SKIP_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'trash', '.openswarm', 'htmlcov', 'coverage', 'vendor']);

/** One reviewer-subagent unit of work: a directory (or a chunk of a big one). */
export interface AuditArea {
  /** Human label, e.g. `src/tui/panels` or `src/agents (2/3)`. */
  label: string;
  /** The directory this area covers (repo-relative). */
  dir: string;
  /** Source files in this area (repo-relative, sorted). */
  files: string[];
}

/** Result of reviewing one area: a verdict, or an error if the subagent failed. */
export interface AuditAreaResult {
  area: AuditArea;
  review?: ReviewResult;
  error?: string;
}

/** Per-area summary row for the aggregate report. */
export interface AuditAreaSummary {
  label: string;
  decision: ReviewResult['decision'] | 'error';
  issueCount: number;
  actionCount: number;
}

export interface AuditSummary {
  /** Rolled-up verdict: reject if any area rejects, else revise if any revises, else approve. */
  decision: ReviewResult['decision'];
  totalAreas: number;
  completed: number;
  failed: number;
  areas: AuditAreaSummary[];
  /** All issues, each prefixed with its area label. */
  issues: string[];
  /** All recommended follow-ups, with the area folded into `location`. */
  recommendedActions: RecommendedAction[];
}

/** Drop non-source, test, and junk-dir files. Pure. */
export function filterSourceFiles(files: string[]): string[] {
  return files.filter((f) => {
    const ext = f.slice(f.lastIndexOf('.'));
    if (!SOURCE_EXTENSIONS.has(ext)) return false;
    if (TEST_PATTERNS.some((re) => re.test(f))) return false;
    if (f.split('/').some((seg) => SKIP_DIR_SEGMENTS.has(seg))) return false;
    return true;
  });
}

/**
 * Prefer a conventional production-source root: if any `src/` files exist, audit
 * only those (drops benchmarks/scripts/config at the repo root); otherwise fall
 * back to the full source set. Pure. (extend the prefix list if a repo uses
 * lib/ or packages/ instead.)
 */
export function preferSrcRoot(files: string[]): string[] {
  const src = files.filter((f) => f.startsWith('src/'));
  return src.length ? src : files;
}

/**
 * List the repo's tracked source files via `git ls-files` (honors .gitignore),
 * keep production source, and prefer the src/ root. Throws if `cwd` isn't a git
 * repo.
 */
export function listSourceFiles(cwd: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = filterSourceFiles(out.split('\n').map((l) => l.trim()).filter(Boolean));
  return preferSrcRoot(all);
}

/**
 * Partition source files into areas. Each directory becomes one area; a
 * directory with more than `maxFilesPerArea` files is split into numbered
 * chunks so a single reviewer subagent never gets an unreadable pile. Pure and
 * deterministic (dirs and files sorted). (INT-2006)
 */
export function partitionIntoAreas(files: string[], maxFilesPerArea = 12): AuditArea[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
  }

  const areas: AuditArea[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const dirFiles = byDir.get(dir)!.sort();
    if (dirFiles.length <= maxFilesPerArea) {
      areas.push({ label: dir, dir, files: dirFiles });
      continue;
    }
    // Split oversized directories into evenly numbered chunks.
    const chunks = Math.ceil(dirFiles.length / maxFilesPerArea);
    for (let i = 0; i < chunks; i++) {
      const slice = dirFiles.slice(i * maxFilesPerArea, (i + 1) * maxFilesPerArea);
      areas.push({ label: `${dir} (${i + 1}/${chunks})`, dir, files: slice });
    }
  }
  return areas;
}

/**
 * Roll N per-area results into one verdict + merged issues/actions. The worst
 * decision wins (reject > revise > approve); errored areas are counted but don't
 * affect the decision (a crashed subagent shouldn't silently "approve"). Pure.
 */
export function aggregateAuditResults(results: AuditAreaResult[]): AuditSummary {
  const areas: AuditAreaSummary[] = [];
  const issues: string[] = [];
  const recommendedActions: RecommendedAction[] = [];
  let worst: ReviewResult['decision'] = 'approve';
  let completed = 0;
  let failed = 0;
  // Cross-area dedup: a fan-out reviewer often flags a shared file it imported,
  // so the same finding shows up under several areas. Keep the first. (INT-2022)
  const seen = new Set<string>();

  const rank = (d: ReviewResult['decision']): number => (d === 'reject' ? 2 : d === 'revise' ? 1 : 0);

  // True when a follow-up's location points at a file this area actually owns.
  // Reviewers may read imports to understand them, but a finding outside the area
  // is audited by its own area — dropping it here removes the fan-out duplicate. (INT-2022)
  const inArea = (location: string | undefined, area: AuditArea): boolean => {
    if (!location) return true; // area-level note, keep
    const path = location.split(':')[0].trim();
    return area.files.includes(path) || path === area.dir || path.startsWith(area.dir + '/');
  };

  for (const { area, review, error } of results) {
    if (error || !review) {
      failed++;
      areas.push({ label: area.label, decision: 'error', issueCount: 0, actionCount: 0 });
      continue;
    }
    completed++;
    if (rank(review.decision) > rank(worst)) worst = review.decision;

    const reviewIssues = review.issues ?? [];
    reviewIssues.forEach((i) => issues.push(`[${area.label}] ${i}`));

    let kept = 0;
    for (const a of review.recommendedActions ?? []) {
      // (B) area isolation — drop findings outside this area (audited elsewhere).
      if (!inArea(a.location, area)) continue;
      // (A) dedup by type + file:line across all areas.
      const key = `${a.type}|${a.location ?? a.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recommendedActions.push({
        ...a,
        // Fold the area into the location so the merged list stays traceable.
        location: a.location ? `${area.label}: ${a.location}` : area.label,
      });
      kept++;
    }

    areas.push({
      label: area.label,
      decision: review.decision,
      issueCount: reviewIssues.length,
      actionCount: kept,
    });
  }

  return { decision: worst, totalAreas: results.length, completed, failed, areas, issues, recommendedActions };
}

/**
 * Render the audit as a persistable markdown report. Pure — timestamp is injected
 * (no Date.now() inside) so it's deterministic and testable. (INT-2022)
 */
export function formatAuditReport(summary: AuditSummary, repoName: string, timestamp: string): string {
  const mark = (d: AuditAreaSummary['decision']) =>
    d === 'approve' ? '✓' : d === 'revise' ? '✎' : d === 'reject' ? '✗' : '⚠';
  const approved = summary.areas.filter((a) => a.decision === 'approve').length;
  const revised = summary.areas.filter((a) => a.decision === 'revise').length;
  const rejected = summary.areas.filter((a) => a.decision === 'reject').length;

  const lines: string[] = [];
  lines.push(`# Codebase audit — ${repoName}`);
  lines.push('');
  lines.push(`\`openswarm review --max\` · ${timestamp}`);
  lines.push('');
  lines.push(
    `**${summary.totalAreas} area(s)** — ${summary.completed} reviewed, ${summary.failed} failed · ` +
      `${approved} ✓ / ${revised} ✎ / ${rejected} ✗ · **Verdict: ${summary.decision.toUpperCase()}**`,
  );
  lines.push('');

  const failedAreas = summary.areas.filter((a) => a.decision === 'error');
  if (failedAreas.length) {
    lines.push(`## ⚠ Reviewer failures (${failedAreas.length})`);
    lines.push('These areas were NOT audited (subagent error). Re-run to cover them.');
    failedAreas.forEach((a) => lines.push(`- ${a.label}`));
    lines.push('');
  }

  lines.push('## Areas');
  lines.push('| area | verdict | issues | follow-ups |');
  lines.push('|---|---|---|---|');
  summary.areas.forEach((a) => lines.push(`| ${a.label} | ${mark(a.decision)} | ${a.issueCount} | ${a.actionCount} |`));
  lines.push('');

  if (summary.recommendedActions.length) {
    lines.push(`## Recommended follow-ups (${summary.recommendedActions.length}, deduped)`);
    const byType = new Map<string, RecommendedAction[]>();
    for (const a of summary.recommendedActions) {
      (byType.get(a.type) ?? byType.set(a.type, []).get(a.type)!).push(a);
    }
    for (const [type, actions] of [...byType.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push('');
      lines.push(`### ${type} (${actions.length})`);
      actions.forEach((a) => lines.push(`- ${a.title}${a.location ? ` — \`${a.location}\`` : ''}`));
    }
    lines.push('');
  }

  if (summary.issues.length) {
    lines.push(`## Issues (${summary.issues.length})`);
    summary.issues.forEach((i) => lines.push(`- ${i}`));
  }

  return lines.join('\n');
}

/** Render the aggregate audit verdict for the terminal. Pure. */
export function formatAuditSummary(summary: AuditSummary): string {
  const mark = (d: AuditAreaSummary['decision']) =>
    d === 'approve' ? '✓' : d === 'revise' ? '✎' : d === 'reject' ? '✗' : '⚠';
  const lines: string[] = [];

  const approved = summary.areas.filter((a) => a.decision === 'approve').length;
  const revised = summary.areas.filter((a) => a.decision === 'revise').length;
  const rejected = summary.areas.filter((a) => a.decision === 'reject').length;
  lines.push(
    `Codebase audit — ${summary.totalAreas} area(s): ${approved} ✓, ${revised} ✎ revise, ${rejected} ✗ reject` +
      (summary.failed ? `  [${summary.failed} failed]` : ''),
  );
  lines.push(`Verdict: ${summary.decision.toUpperCase()}`);
  lines.push('');

  for (const a of summary.areas) {
    const counts =
      a.decision === 'error' ? '(subagent failed)' : `${a.issueCount} issue(s), ${a.actionCount} follow-up(s)`;
    lines.push(`  ${mark(a.decision)} ${a.label}  ${counts}`);
  }

  if (summary.issues.length) {
    lines.push('', `Issues (${summary.issues.length}):`);
    summary.issues.forEach((i) => lines.push(`  - ${i}`));
  }
  if (summary.recommendedActions.length) {
    lines.push('', `Recommended follow-ups (${summary.recommendedActions.length}):`);
    summary.recommendedActions.forEach((a) =>
      lines.push(`  - [${a.type}] ${a.title}${a.location ? ` (${a.location})` : ''}`),
    );
  }
  return lines.join('\n');
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Live fan-out progress events — consumed by the ink board (or any listener). */
export type AuditProgress =
  | { type: 'start'; label: string; done: number; total: number }
  | { type: 'log'; label: string; line: string }
  | { type: 'done'; label: string; decision: ReviewResult['decision']; done: number; total: number }
  | { type: 'error'; label: string; error: string; done: number; total: number };

export interface RunMaxReviewOptions {
  /** Max reviewer subagents in flight at once. */
  concurrency: number;
  /** Adapter override for the reviewers. */
  adapter?: AdapterName;
  /** Abort the whole audit (Ctrl+C) — propagated to every subagent. */
  signal?: AbortSignal;
}

export interface RunMaxReviewDeps {
  /** Review one area → verdict. Default spawns a real reviewer subagent. Injectable for tests. */
  review?: (area: AuditArea, onLog: (line: string) => void) => Promise<ReviewResult>;
  /** Live progress sink (the ink board). */
  onProgress?: (e: AuditProgress) => void;
}

/** Aggregate verdict plus the per-area results (kept for area-by-area Linear filing). */
export interface AuditRun {
  summary: AuditSummary;
  results: AuditAreaResult[];
  /** Set when a codex usage-limit aborted the run early (remaining areas skipped). (INT-2192) */
  rateLimit?: RateLimitError;
}

/** Default area reviewer: spawn an independent reviewer subagent over the area's files. */
async function defaultReviewArea(
  area: AuditArea,
  cwd: string,
  opts: RunMaxReviewOptions,
  onLog: (line: string) => void,
): Promise<ReviewResult> {
  const { runReviewer } = await import('../agents/reviewer.js');
  const { buildReviewWorkerResult } = await import('./reviewCommand.js');
  return runReviewer({
    mode: 'audit',
    taskTitle: `Codebase audit: ${area.label}`,
    taskDescription:
      `Audit the ${area.files.length} existing source file(s) under ${area.label} for correctness bugs, ` +
      `security issues, resource leaks, and quality problems.`,
    workerResult: buildReviewWorkerResult(area.files, `Codebase audit of ${area.label}`),
    projectPath: cwd,
    adapterName: opts.adapter as never,
    signal: opts.signal,
    onLog,
  });
}

/**
 * Fan a reviewer subagent out over each area with a concurrency cap, then
 * aggregate. Areas are partitioned by the caller (so the board can show them
 * up-front and the cost gate can count them). Never throws on a single area
 * failure — that area lands as an error in the summary. (INT-2006)
 */
export async function runMaxReview(
  areas: AuditArea[],
  cwd: string,
  opts: RunMaxReviewOptions,
  deps: RunMaxReviewDeps = {},
): Promise<AuditRun> {
  const review = deps.review ?? ((area, onLog) => defaultReviewArea(area, cwd, opts, onLog));
  const total = areas.length;
  let done = 0;
  // Once a codex usage-limit hits, stop launching new area reviews — they'd all
  // fail against the same exhausted quota (the STONKS "5/16 → end" wipeout). Keep
  // the typed error so the caller can report the reset time. (INT-2192)
  let rateLimit: RateLimitError | null = null;

  const settled = await runPool(
    areas,
    opts.concurrency,
    async (area) => {
      if (rateLimit) throw new Error('skipped: codex usage limit already hit this run');
      deps.onProgress?.({ type: 'start', label: area.label, done, total });
      try {
        return await review(area, (line) => deps.onProgress?.({ type: 'log', label: area.label, line }));
      } catch (e) {
        if (e instanceof RateLimitError) rateLimit = e;
        throw e;
      }
    },
    (s) => {
      done++;
      const area = areas[s.index];
      if (s.error) {
        deps.onProgress?.({ type: 'error', label: area.label, error: String(s.error), done, total });
      } else if (s.value) {
        deps.onProgress?.({ type: 'done', label: area.label, decision: s.value.decision, done, total });
      }
    },
  );

  const results: AuditAreaResult[] = settled.map((s, i) =>
    s.error || !s.value ? { area: areas[i], error: s.error ? String(s.error) : 'no result' } : { area: areas[i], review: s.value },
  );
  return { summary: aggregateAuditResults(results), results, rateLimit: rateLimit ?? undefined };
}

/**
 * Merge a fallback run (a retry of the primary run's failed/skipped areas on a
 * different adapter) back over the primary results, then re-aggregate. The
 * fallback's own rateLimit (e.g. claude also exhausted) carries forward. (INT-2192)
 */
export function mergeFallback(primary: AuditRun, fallback: AuditRun): AuditRun {
  const fb = new Map(fallback.results.map((r) => [r.area.label, r]));
  const results = primary.results.map((r) => (r.error && fb.has(r.area.label) ? fb.get(r.area.label)! : r));
  return { summary: aggregateAuditResults(results), results, rateLimit: fallback.rateLimit };
}
