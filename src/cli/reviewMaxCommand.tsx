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
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import {
  listSourceFiles,
  balanceAreasToConcurrency,
  runMaxReview,
  runAreaFixes,
  fixTargets,
  formatAuditSummary,
  formatAuditReport,
  mergeFallback,
  type AuditArea,
  type AuditRun,
  type AuditSummary,
} from './reviewAudit.js';
import { AuditBoard } from '../tui/components/AuditBoard.js';
import { resolveIssueFromBranch, ensureTaskSource, resolveProjectId } from './reviewCommand.js';
import { synthesizeAuditIssues } from './auditPM.js';
import { status } from '../support/colors.js';
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
  /** PM-synthesize follow-ups into ≤10 cohesive Linear sub-issues (parent id or branch-inferred). */
  fileIssue?: string | boolean;
  /** Legacy: file one follow-up batch per audit area (the old --issues behavior). (INT-2225) */
  issuesPerArea?: string | boolean;
  /** Skip the interactive cost gate (CI / scripted). */
  yes?: boolean;
  /** Partition only, print the plan, and exit (no subagents spawned). */
  dryRun?: boolean;
  /** Report file path (default: <cwd>/.openswarm/audit/audit-<ts>.md). (INT-2022) */
  out?: string;
  /** Skip creating the default Linear master audit issue. (INT-2022) */
  noLinear?: boolean;
  /** Adapter to retry usage-limited areas on (default claude for codex primary). (INT-2192) */
  fallbackAdapter?: string;
  /** Disable the automatic usage-limit fallback. (INT-2192) */
  noFallback?: boolean;
  /** Apply the reviewer's fixes to each non-approve area (working tree only). (INT-2249) */
  fix?: boolean;
  /** Record the audit findings into repo knowledge (default true; --no-learn opts out). (INT-2268) */
  learn?: boolean;
}

/**
 * Pick the adapter to retry usage-limited areas on. Explicit --fallback wins;
 * otherwise a codex primary auto-falls back to claude (Claude subscription). (INT-2192)
 */
function resolveFallbackAdapter(opts: ReviewMaxOptions): AdapterName | undefined {
  if (opts.noFallback) return undefined;
  if (opts.fallbackAdapter) return opts.fallbackAdapter as AdapterName;
  const primary = opts.adapter ?? 'codex-responses';
  return primary === 'codex' || primary === 'codex-responses' ? 'claude' : undefined;
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
  // Split down to fill the reviewer pool: fewer areas than `concurrency` would
  // leave subagents idle, so the fastest audit maximizes parallel spread. (INT-2249)
  const areas: AuditArea[] = balanceAreasToConcurrency(files, concurrency, opts.maxFilesPerArea ?? 12);

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

  // Auto-fallback: a codex usage-limit aborted the run early → retry the failed/
  // skipped areas on the fallback adapter (default claude → Claude subscription). (INT-2192)
  if (run.rateLimit) {
    const fallback = resolveFallbackAdapter(opts);
    if (fallback) {
      const pending = areas.filter((_, i) => run.results[i]?.error);
      console.warn(`\n${status.warn(`Codex usage limit hit — falling back to "${fallback}" for ${pending.length} remaining area(s)...`)}`);
      const fbRun = await runMaxReview(
        pending,
        cwd,
        { concurrency, adapter: fallback },
        {
          onProgress: (e) => {
            if (e.type === 'done') console.error(`  [${fallback}] ${e.label}: ${e.decision}`);
            else if (e.type === 'error') console.error(`  [${fallback}] ${e.label}: failed`);
          },
        },
      );
      run = mergeFallback(run, fbRun);
    }
  }

  console.log(formatAuditSummary(run.summary));

  // If a usage-limit is still unresolved (fallback also exhausted, or no fallback),
  // surface the reset time. (INT-2192)
  if (run.rateLimit) {
    const skipped = run.summary.areas.filter((a) => a.decision === 'error').length;
    const when = run.rateLimit.resetsAt ? new Date(run.rateLimit.resetsAt * 1000).toLocaleString() : 'an unknown time';
    console.warn(`\n${status.warn(`Usage limit unresolved — ${skipped} area(s) still incomplete. ${run.rateLimit.message}`)}`);
    console.warn(`  Retry after ${when}${resolveFallbackAdapter(opts) ? ' (fallback adapter also exhausted)' : ', or set `--fallback <adapter>`'}.`);
  }

  // (3) Persist a markdown report so the result isn't lost to the scrollback. (INT-2022)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const report = formatAuditReport(run.summary, basename(cwd) || cwd, ts);
  const outPath = opts.out ?? join(cwd, '.openswarm', 'audit', `audit-${ts}.md`);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, report, 'utf8');
    console.log(`\nReport saved: ${outPath}`);
  } catch (e) {
    console.warn(`Could not save report: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (3.5) --fix: apply the reviewer's findings for every non-approve area,
  //       fanned out with the same concurrency. Edits land in the working tree —
  //       no commit, no re-review — so the user reviews the diff first. (INT-2249)
  if (opts.fix) {
    const targets = fixTargets(run);
    if (!targets.length) {
      console.log('\n--fix: nothing to apply (every area approved).');
    } else {
      console.log(`\nApplying fixes across ${targets.length} area(s) with ${concurrency} concurrent worker(s)...`);
      const fixes = await runAreaFixes(
        run,
        cwd,
        { concurrency, adapter: opts.adapter as AdapterName | undefined },
        {
          onProgress: (e) => {
            if (e.type === 'done') console.log(`  ${status.ok(`${e.label} — ${e.filesChanged} file(s) changed`)}`);
            else if (e.type === 'error') console.log(`  ${status.err(`${e.label} — ${e.error}`)}`);
          },
        },
      );
      const edited = fixes.filter((f) => f.applied && f.filesChanged.length);
      const failed = fixes.filter((f) => !f.applied);
      const touched = [...new Set(edited.flatMap((f) => f.filesChanged))];
      console.log(
        `\n--fix: ${edited.length}/${targets.length} area(s) edited, ${touched.length} file(s) touched` +
          `${failed.length ? `, ${failed.length} failed` : ''}.`,
      );
      console.log('Changes are in the working tree — review the diff before committing.');
    }
  }

  // (4) Linear: PM synthesis is the DEFAULT — a master parent + ≤10 cohesive
  //     sub-issues. `--issues <id>` overrides the parent with an existing issue;
  //     `--issues-per-area` keeps the legacy per-area fan-out; `--no-linear`
  //     skips Linear entirely (report only). (INT-2022 / INT-2225)
  if (opts.issuesPerArea) {
    await filePerAreaFollowups(cwd, opts.issuesPerArea, run);
  } else if (!opts.noLinear && run.summary.recommendedActions.length) {
    await filePmSynthesizedIssues(cwd, opts, run.summary, report, ts);
  } else if (run.summary.recommendedActions.length) {
    console.log(`\n${run.summary.recommendedActions.length} follow-up(s) — captured in the report (--no-linear).`);
  }

  // (5) Learn: record the audit's top findings as one repo constraint so the
  // next worker/reviewer knows this repo's known pitfalls. One memory (capped),
  // not one-per-finding. (INT-2268)
  if (opts.learn !== false && run.summary.recommendedActions.length) {
    try {
      const { recordAuditFindings } = await import('../memory/repoKnowledge.js');
      await recordAuditFindings(cwd, { decision: run.summary.decision, recommendedActions: run.summary.recommendedActions });
    } catch {
      // recordAuditFindings is already non-throwing.
    }
  }

  return { decision: run.summary.decision };
}

/**
 * Create one master audit issue holding the full report (default Linear
 * behavior). Returns the created issue's internal id (usable as a sub-issue
 * parent) or null on failure. (INT-2022 / INT-2225)
 */
async function createMasterAuditIssue(
  cwd: string,
  summary: AuditSummary,
  report: string,
  ts: string,
): Promise<string | null> {
  const source = await ensureTaskSource();
  if (!source) {
    console.log('Linear not connected — report saved to file only. `openswarm auth login --provider linear` to enable.');
    return null;
  }
  const projectId = await resolveProjectId(cwd);
  const title = `chore(audit): codebase audit ${ts.slice(0, 10)} — review --max (${summary.recommendedActions.length} follow-ups)`;
  try {
    const res = await source.createTask(title, report, projectId);
    if ('identifier' in res) {
      console.log(`Linear master audit issue: ${res.identifier}`);
      return res.id;
    }
    console.warn(`Could not create Linear issue (report saved to file): ${res.error}`);
    return null;
  } catch (e) {
    console.warn(`Could not create Linear issue (report saved to file): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * PM layer for `--issues`: synthesize the deduped follow-ups into ≤10 cohesive
 * issues and file them as sub-issues. The parent is the explicit `--issues <id>`
 * when given, otherwise a freshly created master audit issue (which also holds
 * the full report). Falls back gracefully — if synthesis yields nothing (too few
 * follow-ups, or the LLM output couldn't be parsed), the master issue alone still
 * captures everything. (INT-2225)
 */
async function filePmSynthesizedIssues(
  cwd: string,
  opts: ReviewMaxOptions,
  summary: AuditSummary,
  report: string,
  ts: string,
): Promise<void> {
  const actions = summary.recommendedActions;
  if (!actions.length) {
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
  const projectId = await resolveProjectId(cwd);
  if (!projectId) {
    // No <repo>/openswarm.json mapping → issues get filed without a project (and
    // on a multi-team config, only the first team). Tell the user how to map it. (INT-2239)
    console.warn(
      status.warn(
        'No Linear project mapped for this repo (openswarm.json `linear.projectId` missing) — ' +
          'issues will not be linked to a project. Run `openswarm add` here to map it.',
      ),
    );
  }

  // Resolve the parent: explicit --issues <id>, else create the master report issue.
  let parentId: string | undefined =
    typeof opts.fileIssue === 'string' && opts.fileIssue ? opts.fileIssue : undefined;
  if (!parentId && !opts.noLinear) {
    parentId = (await createMasterAuditIssue(cwd, summary, report, ts)) ?? undefined;
  }

  console.log(`Synthesizing ${actions.length} follow-up(s) into cohesive issues (PM pass)...`);
  const issues = await synthesizeAuditIssues(actions, {
    adapter: opts.adapter,
    cwd,
    repoName: basename(cwd) || cwd,
    onLog: (l) => console.error(`  · ${l}`),
  });

  if (!issues.length) {
    console.log(
      parentId
        ? 'PM synthesis produced no grouped issues — the master audit issue captures all follow-ups.'
        : 'PM synthesis produced no grouped issues — follow-ups are captured in the saved report.',
    );
    return;
  }

  let filed = 0;
  for (const issue of issues) {
    try {
      const res = parentId
        ? await source.createSubIssue(parentId, issue.title, issue.description, {
            priority: issue.priority,
            projectId,
          })
        : await source.createTask(issue.title, issue.description, projectId);
      if ('identifier' in res) {
        filed++;
        console.log(`  ${status.ok(`${res.identifier}  ${issue.title}  (${issue.items.length} follow-up(s))`)}`);
      } else {
        console.warn(`  ${status.err(`Could not create issue "${issue.title}": ${res.error}`)}`);
      }
    } catch (e) {
      console.warn(`  ${status.err(`Could not create issue "${issue.title}": ${e instanceof Error ? e.message : String(e)}`)}`);
    }
  }

  console.log(
    filed > 0
      ? parentId
        ? `Filed ${filed} synthesized sub-issue(s) under the master audit issue.`
        : `Filed ${filed} synthesized issue(s).`
      : 'Could not file synthesized issues (0 created).',
  );
}
