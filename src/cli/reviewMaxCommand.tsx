// ============================================
// OpenSwarm - `openswarm review --max` entry (INT-2006)
// ============================================
//
// CLI shell for the full-codebase, multi-agent audit: collect source → partition
// into areas → cost gate → mount the live ink board → fan reviewer subagents out
// (runMaxReview) → print the aggregate verdict → optionally file per-area Linear
// follow-ups. The orchestration/aggregation lives in reviewAudit.ts (unit-tested
// and ink-free); this file is the effectful boundary.
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import {
  listSourceFiles,
  partitionIntoAreas,
  runMaxReview,
  formatAuditSummary,
  type AuditArea,
  type AuditRun,
} from './reviewAudit.js';
import { AuditBoard } from '../tui/components/AuditBoard.js';
import { resolveIssueFromBranch, ensureTaskSource, resolveProjectId } from './reviewCommand.js';
import type { AdapterName } from '../adapters/types.js';

export interface ReviewMaxOptions {
  /** Project path (default cwd). */
  path?: string;
  /** Max reviewer subagents in flight (default 4). */
  concurrency?: number;
  /** Files per area before chunking (default 12). */
  maxFilesPerArea?: number;
  /** Adapter override for the reviewers. */
  adapter?: string;
  /** File per-area follow-ups as Linear issues (parent id or branch-inferred). */
  fileIssue?: string | boolean;
  /** Skip the interactive cost gate (CI / scripted). */
  yes?: boolean;
  /** Partition only, print the plan, and exit (no subagents spawned). */
  dryRun?: boolean;
}

/** Interactive cost gate. Non-TTY always proceeds (scripted runs). */
async function confirmCost(areas: number, files: number, concurrency: number): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((res) =>
    rl.question(
      `Audit ${files} file(s) across ${areas} area(s) with ${concurrency} concurrent reviewer subagents ` +
        `(~${areas} agent runs). Continue? [y/N] `,
      res,
    ),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** File each area's recommendedActions as Linear follow-ups, one call per area (avoids the 10-action cap). */
async function filePerAreaFollowups(cwd: string, fileIssue: string | boolean, run: AuditRun): Promise<void> {
  const withActions = run.results.filter((r) => r.review?.recommendedActions?.length);
  if (!withActions.length) {
    console.log('No follow-ups to file.');
    return;
  }
  const source = await ensureTaskSource();
  if (!source) {
    console.log(
      'Could not file follow-ups: Linear not connected. Run `openswarm auth login --provider linear` (or set linearApiKey).',
    );
    return;
  }

  let parent = typeof fileIssue === 'string' ? fileIssue : undefined;
  if (!parent) {
    const branch = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        return '';
      }
    })();
    parent = resolveIssueFromBranch(branch);
    if (parent) console.log(`Filing follow-ups under ${parent} (inferred from branch "${branch}").`);
  }
  const projectId = parent ? undefined : await resolveProjectId(cwd);

  const { fileReviewerFollowups } = await import('../automation/runnerExecution.js');
  let filed = 0;
  for (const r of withActions) {
    filed += await fileReviewerFollowups(source, parent, r.review!, { autoFile: true, projectId, requireApprove: false });
  }
  console.log(
    filed > 0
      ? parent
        ? `Filed ${filed} follow-up sub-issue(s) under ${parent}.`
        : `Filed ${filed} standalone follow-up issue(s) (pass \`--issues <id>\` to nest them).`
      : 'Could not file follow-ups (0 created).',
  );
}

/**
 * Run the full-codebase multi-agent audit. Returns the aggregate verdict (or
 * null when there's nothing to audit / the user declined). exit code is set to 1
 * by the caller on a reject verdict.
 */
export async function runReviewMaxCommand(opts: ReviewMaxOptions = {}): Promise<{ decision: string } | null> {
  const cwd = opts.path ?? process.cwd();
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  let files: string[];
  try {
    files = listSourceFiles(cwd);
  } catch {
    console.error(`Not a git repository (or git unavailable): ${cwd}`);
    return null;
  }
  if (!files.length) {
    console.log('No production source files to audit.');
    return null;
  }
  const areas: AuditArea[] = partitionIntoAreas(files, opts.maxFilesPerArea ?? 12);

  if (opts.dryRun) {
    console.log(`Audit plan — ${files.length} file(s) across ${areas.length} area(s):`);
    areas.forEach((a) => console.log(`  · ${a.label}  (${a.files.length} file(s))`));
    return null;
  }

  if (!opts.yes && !(await confirmCost(areas.length, files.length, concurrency))) {
    console.log('Aborted.');
    return null;
  }

  // Live board → stderr so the final report on stdout stays pipe-clean.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const board = render(<AuditBoard areas={areas} concurrency={concurrency} events={events} />, {
    stdout: process.stderr as unknown as NodeJS.WriteStream,
  });

  let run: AuditRun;
  try {
    run = await runMaxReview(
      areas,
      cwd,
      { concurrency, adapter: opts.adapter as AdapterName | undefined },
      { onProgress: (e) => events.emit('progress', e) },
    );
  } finally {
    board.unmount();
  }

  console.log(formatAuditSummary(run.summary));

  if (opts.fileIssue) {
    await filePerAreaFollowups(cwd, opts.fileIssue, run);
  } else if (run.summary.recommendedActions.length) {
    console.log(
      `\n${run.summary.recommendedActions.length} follow-up(s) suggested. Re-run with \`--issues\` to file them as Linear issues.`,
    );
  }

  return { decision: run.summary.decision };
}
