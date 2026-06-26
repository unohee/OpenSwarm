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

/** Render a review verdict for the terminal. */
export function formatReviewOutput(review: ReviewResult): string {
  const lines: string[] = [];
  const mark = review.decision === 'approve' ? '✓' : review.decision === 'reject' ? '✗' : '✎';
  lines.push(`${mark} Decision: ${review.decision.toUpperCase()}`);
  if (review.feedback) lines.push(`  ${review.feedback}`);
  if (review.issues?.length) {
    lines.push('  Issues:');
    review.issues.forEach((i) => lines.push(`    - ${i}`));
  }
  if (review.suggestions?.length) {
    lines.push('  Suggestions:');
    review.suggestions.forEach((s) => lines.push(`    - ${s}`));
  }
  if (review.recommendedActions?.length) {
    lines.push('  Recommended follow-ups:');
    review.recommendedActions.forEach((a) =>
      lines.push(`    - [${a.type}] ${a.title}${a.location ? ` (${a.location})` : ''}`),
    );
  }
  return lines.join('\n');
}

export interface ReviewCommandOptions {
  /** Project path (default cwd). */
  path?: string;
  /** Parent Linear issue id — file recommendedActions as sub-issues under it. */
  fileIssue?: string;
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
  log(formatReviewOutput(result));

  if (opts.fileIssue && result.recommendedActions?.length) {
    const fileFollowups =
      deps.fileFollowups ??
      (async (parent: string, r: ReviewResult) => {
        const { fileReviewerFollowups, getTaskSource } = await import('../automation/runnerExecution.js');
        return fileReviewerFollowups(getTaskSource(), parent, r, { autoFile: true });
      });
    const filed = await fileFollowups(opts.fileIssue, result);
    log(`Filed ${filed} follow-up sub-issue(s) under ${opts.fileIssue}.`);
  }

  return result;
}
