// ============================================
// OpenSwarm - `openswarm review` (INT-1955)
// ============================================
//
// Run the reviewer over the working-tree changes from the CLI, print the
// verdict, and (optionally) file its recommendedActions as Linear sub-issues
// under a parent issue — reusing fileReviewerFollowups (INT-1704/INT-1954).
// The formatter and synthetic-WorkerResult builder are pure (unit-tested); the
// command shell wires git + reviewer + Linear.

import type { ReviewResult, WorkerResult } from '../agents/agentPair.js';
import { startReviewProgress } from './reviewProgress.js';

/** Synthesize a WorkerResult describing the working-tree changes for the reviewer. */
export function buildReviewWorkerResult(changedFiles: string[], summary?: string): WorkerResult {
  return {
    success: true,
    summary: summary ?? `Working-tree review of ${changedFiles.length} changed file(s)`,
    filesChanged: changedFiles,
    commands: [],
    output: '',
  };
}

// Minimal ANSI helpers — no extra dep. Wrappers only, so plain substrings
// (e.g. 'Decision: APPROVE') survive for tests/grep. (INT-1966)
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

/**
 * Render a review verdict for the terminal. `color` adds ANSI styling (decision
 * green/yellow/red, bold section headers, dim locations); off → plain text. (INT-1966)
 */
export function formatReviewOutput(review: ReviewResult, color = false): string {
  const c = (code: string, s: string) => (color ? `${code}${s}${ANSI.reset}` : s);
  const header = (s: string) => c(ANSI.bold, s);
  const decisionColor =
    review.decision === 'approve' ? ANSI.green : review.decision === 'reject' ? ANSI.red : ANSI.yellow;

  const lines: string[] = [];
  const mark = review.decision === 'approve' ? '✓' : review.decision === 'reject' ? '✗' : '✎';
  lines.push(c(decisionColor, `${c(ANSI.bold, mark)} Decision: ${review.decision.toUpperCase()}`));
  if (review.feedback) lines.push(`  ${review.feedback}`);
  if (review.issues?.length) {
    lines.push(`  ${header('Issues:')}`);
    review.issues.forEach((i) => lines.push(`    ${c(ANSI.red, '-')} ${i}`));
  }
  if (review.suggestions?.length) {
    lines.push(`  ${header('Suggestions:')}`);
    review.suggestions.forEach((s) => lines.push(`    ${c(ANSI.cyan, '-')} ${s}`));
  }
  if (review.recommendedActions?.length) {
    lines.push(`  ${header('Recommended follow-ups:')}`);
    review.recommendedActions.forEach((a) =>
      lines.push(
        `    - ${c(ANSI.cyan, `[${a.type}]`)} ${a.title}${a.location ? ` ${c(ANSI.dim, `(${a.location})`)}` : ''}`,
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Extract a Linear-style issue id (e.g. INT-1705) from a git branch name so the
 * user can run `--issues` without typing the id. Returns undefined if none. (INT-1967)
 */
export function resolveIssueFromBranch(branch: string): string | undefined {
  const m = branch.match(/([a-z]{2,}-\d+)/i);
  return m ? m[1].toUpperCase() : undefined;
}

export interface ReviewCommandOptions {
  /** Project path (default cwd). */
  path?: string;
  /**
   * File recommendedActions as Linear sub-issues. A string is the explicit parent
   * id; `true` (bare `--issues`) infers the parent from the git branch. (INT-1967)
   */
  fileIssue?: string | boolean;
  /** Adapter override. */
  adapter?: string;
  /** Verbose logging. */
  debug?: boolean;
}

/**
 * Run the review flow. Injectable deps keep it testable without git/network.
 */
export async function runReviewCommand(
  opts: ReviewCommandOptions = {},
  deps: {
    getChangedFiles?: (cwd: string) => Promise<string[]>;
    review?: (wr: WorkerResult, cwd: string, onLog?: (line: string) => void) => Promise<ReviewResult>;
    fileFollowups?: (parentIssueId: string, review: ReviewResult) => Promise<number>;
    log?: (line: string) => void;
    /** Override the progress indicator (default: TTY-gated spinner). Tests pass a stub. */
    startProgress?: () => { note: (line: string) => void; stop: () => void } | null;
    /** Current git branch (default: `git rev-parse --abbrev-ref HEAD`). For --issues inference. */
    getBranch?: (cwd: string) => Promise<string>;
  } = {},
): Promise<ReviewResult | null> {
  const cwd = opts.path ?? process.cwd();
  const log = deps.log ?? ((l: string) => console.log(l));

  const getChangedFiles = deps.getChangedFiles ?? (async (c) => (await import('../support/gitTracker.js')).getChangedFiles(c));
  const changed = await getChangedFiles(cwd);
  if (!changed.length) {
    log('No working-tree changes to review.');
    return null;
  }
  if (opts.debug) log(`Reviewing ${changed.length} changed file(s): ${changed.join(', ')}`);

  const review =
    deps.review ??
    (async (wr: WorkerResult, c: string, onLog?: (line: string) => void) => {
      const { runReviewer } = await import('../agents/reviewer.js');
      return runReviewer({
        taskTitle: 'CLI working-tree review',
        taskDescription: 'Review the current working-tree changes for correctness, bugs, and follow-ups.',
        workerResult: wr,
        projectPath: c,
        adapterName: opts.adapter as never,
        onLog,
      });
    });

  // Live "still working" feedback so a multi-second review doesn't look frozen.
  // On a TTY, a spinner heartbeat; otherwise each tool line is printed. (INT-1963)
  const startProgress = deps.startProgress ?? (() => (process.stderr.isTTY ? startReviewProgress() : null));
  const progress = startProgress();
  const onLog = (line: string) => {
    if (progress) progress.note(line);
    else log(`  · ${line}`);
  };

  let result: ReviewResult;
  try {
    result = await review(buildReviewWorkerResult(changed), cwd, onLog);
  } finally {
    progress?.stop();
  }
  log(formatReviewOutput(result, !!process.stdout.isTTY));

  const followups = result.recommendedActions?.length ?? 0;
  if (opts.fileIssue && followups) {
    // Resolve the parent issue: explicit id, else inferred from the git branch. (INT-1967)
    let parent = typeof opts.fileIssue === 'string' ? opts.fileIssue : undefined;
    if (!parent) {
      const getBranch =
        deps.getBranch ??
        (async (c: string) => {
          const { execFileSync } = await import('node:child_process');
          return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: c,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
            .toString()
            .trim();
        });
      const branch = await getBranch(cwd).catch(() => '');
      parent = resolveIssueFromBranch(branch);
      if (parent) log(`Filing follow-ups under ${parent} (inferred from branch "${branch}").`);
    }
    if (!parent) {
      log(
        `\n${followups} follow-up(s) suggested, but no issue could be inferred from the branch. ` +
          'Re-run with `--issues <issue-id>` to choose the parent.',
      );
      return result;
    }
    const fileFollowups =
      deps.fileFollowups ??
      (async (p: string, r: ReviewResult) => {
        const { fileReviewerFollowups, getTaskSource } = await import('../automation/runnerExecution.js');
        return fileReviewerFollowups(getTaskSource(), p, r, { autoFile: true });
      });
    const filed = await fileFollowups(parent, result);
    log(`Filed ${filed} follow-up sub-issue(s) under ${parent}.`);
  } else if (followups) {
    // Suggestions were made but nothing was filed — make the flag discoverable. (INT-1966/1967)
    log(`\n${followups} follow-up(s) suggested. Re-run with \`--issues\` to create them as Linear sub-issues (parent inferred from the branch, or pass \`--issues <id>\`).`);
  }

  return result;
}
