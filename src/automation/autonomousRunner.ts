// OpenSwarm - Autonomous Runner
// Heartbeat → Decision → Execution → Report
import { Cron } from 'croner';
import {
  loadTaskState,
  saveTaskState,
  buildProjectsInfo,
  appendPipelineHistory,
  getPipelineHistory,
  incrementRejection,
  clearRejection,
  getRejectionCount,
  isRejectionLimitReached,
  canRetryNow,
  setRetryTime,
  clearRetryTime,
  formatRetryTime,
  getDailyPaceInfo,
  recordProjectCompletion,
  loadProjectSelection,
  saveProjectSelection,
  recordLastFailureDetail,
  pickFailureDetail,
  type LastFailureEntry,
  type TaskState,
  type ProjectInfo,
} from './runnerState.js';
import {
  DecisionEngine,
  DecisionResult,
  TaskItem,
  getDecisionEngine,
  classifyStuck,
} from '../orchestration/decisionEngine.js';
// ExecutorResult used via execution.reportExecutionResult
import { checkWorkAllowed } from '../support/timeWindow.js';
import { shouldEarlyStuckForInfeasibility } from '../support/feasibilityDetector.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { TaskScheduler, initScheduler, normalizeProjectPath } from '../orchestration/taskScheduler.js';
import {
  PipelineResult,
  formatPipelineResultEmbed,
} from '../agents/pairPipeline.js';
import type { DefaultRolesConfig } from '../core/types.js';
import * as planner from '../support/planner.js';
import * as execution from './runnerExecution.js';
import { reportToDiscord, fetchLinearTasks, getTaskSource } from './runnerExecution.js';
import { t } from '../locale/index.js';
import { broadcastEvent, type SwarmStats } from '../core/eventHub.js';
import { writeProviderOverride } from '../core/providerOverride.js';
import { getTaskState } from '../taskState/store.js';
import { pruneWorktrees, removePreservedWorktreeAt } from '../support/worktreeManager.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { STUCK_LABEL } from '../linear/index.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';
import { detectFileConflicts } from '../orchestration/conflictDetector.js';
import { resolveAdapterDefaultModel } from '../agents/stageModelResolver.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
import type { AdapterName } from '../adapters/types.js';
import { mapModelForProvider as mapModelForAdapter } from '../adapters/modelCompat.js';
import {
  applyBacklogGrooming,
  filterGroomableTasks,
  runBacklogGroomingPlanner,
  summarizeGroomingDecision,
} from './backlogGrooming.js';

// Re-export types and integration setters (used by service.ts)
export { setNotifier, setTaskSource } from './runnerExecution.js';
export type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export type { ProjectInfo } from './runnerState.js';

let runnerInstance: AutonomousRunner | null = null;
const DECISION_SELECTION_OVERSAMPLE = 3;

type RunnableCandidate = { task: TaskItem; projectPath: string };

export function decisionSelectionBudget(availableSlots: number, candidateCount: number): number {
  const slots = Math.max(0, Math.floor(availableSlots));
  const candidates = Math.max(0, Math.floor(candidateCount));
  if (slots === 0 || candidates === 0) return 0;
  return Math.min(candidates, Math.max(slots, slots * DECISION_SELECTION_OVERSAMPLE));
}

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
  private scheduler: TaskScheduler;
  /** Adapter default-model cache for the dashboard PAIR bar (INT-2393). */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();
  private cronJob: Cron | null = null;
  private state: RunnerState = {
    isRunning: false,
    lastHeartbeat: 0,
    consecutiveErrors: 0,
  };

  // Heartbeat concurrency guard
  private _heartbeatRunning = false;

  // Explicitly enabled project paths (allow-list; empty = nothing runs ONLY once
  // the selection has been touched — see projectSelectionTouched).
  private enabledProjects = new Set<string>();

  // Whether the user has explicitly enabled/disabled any project (dashboard/CLI).
  // Before this, an empty enabledProjects means "no selection yet → all allowed
  // projects run" (legacy fallback). After, an empty set means "nothing runs" —
  // so disabling every project actually stops the daemon. (INT-2207)
  private projectSelectionTouched = false;

  /**
   * macOS (APFS default) and Windows have case-insensitive filesystems by
   * default, so `/Users/x/dev/AnalogModeling` and `/Users/x/dev/analogModeling`
   * refer to the same directory. Do the enabled-set comparison in a case-
   * insensitive way on those platforms so UI-captured casing doesn't
   * mismatch Linear's project-name casing.
   */
  private get pathsCaseInsensitive(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  private normalizePath(p: string): string {
    return this.pathsCaseInsensitive ? p.toLowerCase() : p;
  }

  /** Check if a resolved path is under any enabled project */
  private isProjectEnabled(resolvedPath: string): boolean {
    if (this.enabledProjects.size === 0) return false;
    const needle = this.normalizePath(resolvedPath);
    for (const enabled of this.enabledProjects) {
      const hay = this.normalizePath(enabled);
      if (hay === needle) return true;
      if (needle.startsWith(hay + '/')) return true;
    }
    return false;
  }

  /**
   * Whether to apply the enabledProjects allow-list. True once the user has made
   * an explicit selection (touched), OR while any project is enabled. Empty +
   * untouched stays the legacy "run all allowed projects" fallback. (INT-2207)
   */
  private shouldFilterByEnabled(): boolean {
    return this.projectSelectionTouched || this.enabledProjects.size > 0;
  }

  private sameProjectCandidateCap(): number | null {
    const sameProjectParallel = (this.config.allowSameProjectConcurrent ?? true) && (this.config.worktreeMode ?? false);
    if (!sameProjectParallel || this.config.maxConcurrentPerProject == null) return null;
    const cap = Math.floor(this.config.maxConcurrentPerProject);
    const maxConcurrent = this.config.maxConcurrentTasks ?? 1;
    return Math.max(1, Math.min(cap, maxConcurrent));
  }

  private currentProjectLoad(projectPath: string): number {
    const target = normalizeProjectPath(projectPath);
    const queued = this.scheduler.getQueuedTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    const running = this.scheduler.getRunningTasks()
      .filter(task => normalizeProjectPath(task.projectPath) === target)
      .length;
    return queued + running;
  }

  private canQueueProjectCandidate(projectPath: string): boolean {
    const cap = this.sameProjectCandidateCap();
    if (cap == null) return true;
    return this.currentProjectLoad(projectPath) < cap;
  }

  /** Persist the project selection so it survives a restart. No-op under dryRun
   * (tests) to avoid touching the real ~/.openswarm. (INT-2208) */
  private persistSelection(): void {
    if (this.config.dryRun) return;
    saveProjectSelection({ enabled: [...this.enabledProjects], touched: this.projectSelectionTouched });
  }

  // Last fetched Linear tasks (for dashboard display)
  private lastFetchedTasks: TaskItem[] = [];

  // Cache: linearProjectName → resolvedLocalPath (populated during task execution)
  private projectPathCache = new Map<string, string>();

  // Max pace: the daemon always runs at full throughput (concurrency +
  // heartbeat come from config). This flag is now ON by default and never
  // expires — it used to default false and auto-expire after 4h, so every
  // restart silently dropped the dashboard back to "TURBO off" even though real
  // throughput (maxConcurrentTasks + heartbeat) was unchanged. Kept as a manual
  // escape hatch (Discord/dashboard can still toggle it off).
  private turboMode = true;
  private turboExpiresAt: number | null = null;

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private failedTaskRetryTimes = new Map<string, number>(); // issueId → next retry timestamp (ms)
  // Last failure feedback per issue — re-injected into the next attempt's worker
  // prompt so re-picked tasks don't restart blind and repeat the same mistake
  // the reviewer already called out (INT-2474). Persisted; cleared on success.
  private lastFailureDetails = new Map<string, LastFailureEntry>();
  private static readonly MAX_RETRY_COUNT = 4; // Increased from 2 to allow more retries with backoff

  // Rate-limit hold: epoch ms until which all task execution is paused.
  // Set when any adapter returns a 429 / usage_limit_reached response (INT-1906).
  private rateLimitUntil = 0;

  // Issues whose Linear project can't be mapped to a local repo path. Recorded on
  // the first resolve failure so they aren't re-picked every heartbeat (which
  // starved other actionable tasks — they were top-priority but never runnable). (INT-1875)
  private unresolvableIssueIds = new Set<string>();
  private lastBacklogGroomingAt = 0;

  private get taskStateRef(): TaskState {
    return {
      completedTaskIds: this.completedTaskIds,
      failedTaskCounts: this.failedTaskCounts,
      failedTaskRetryTimes: this.failedTaskRetryTimes,
      lastFailureDetails: this.lastFailureDetails,
    };
  }

  private loadTaskState(): void {
    loadTaskState(this.taskStateRef);
  }

  private saveTaskState(): void {
    saveTaskState(this.taskStateRef);
  }

  private formatTaskContext(task: TaskItem): string {
    const parts: string[] = [];
    if (task.linearProject?.name) parts.push(`[${task.linearProject.name}]`);
    if (task.issueIdentifier) parts.push(task.issueIdentifier);
    else if (task.issueId) parts.push(task.issueId.slice(0, 8));
    return parts.length > 0 ? parts.join(' ') : '';
  }

  constructor(config: AutonomousConfig) {
    this.config = config;
    this.loadTaskState();  // Restore completed/failed task IDs from disk
    // Restore the persisted project selection so "disable all" survives a daemon
    // restart. Skipped under dryRun (tests) so the real ~/.openswarm isn't touched. (INT-2208)
    if (!config.dryRun) {
      const sel = loadProjectSelection();
      this.enabledProjects = new Set(sel.enabled);
      this.projectSelectionTouched = sel.touched;
    }
    this.engine = getDecisionEngine({
      allowedProjects: config.allowedProjects,
      linearTeamId: config.linearTeamId,
      autoExecute: config.autoExecute,
      maxConsecutiveTasks: config.maxConsecutiveTasks,
      cooldownSeconds: config.cooldownSeconds,
      dryRun: config.dryRun,
      includeBacklog: config.includeBacklog,
      // Same-project parallel selection only makes sense when the scheduler can
      // actually run those tasks concurrently (worktree isolation). (INT-2318)
      sameProjectParallel: (config.allowSameProjectConcurrent ?? true) && (config.worktreeMode ?? false),
    });

    // Initialize TaskScheduler
    // Same-repo parallelism is opt-in via config (default true) but the scheduler
    // force-disables it unless worktreeMode is on — see TaskScheduler guard. (INT-1975)
    this.scheduler = initScheduler({
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: config.allowSameProjectConcurrent ?? true,
      maxConcurrentPerProject: config.maxConcurrentPerProject,
      worktreeMode: config.worktreeMode ?? false,
    });

    // Set up scheduler event handling
    this.setupSchedulerEvents();
  }

  private setupSchedulerEvents(): void {
    this.scheduler.on('started', async (running) => {
      const taskCtx = this.formatTaskContext(running.task);
      console.log(`[Scheduler] Task started: ${taskCtx} ${running.task.title}`);
      broadcastEvent({ type: 'task:started', data: { taskId: running.task.id, title: running.task.title, issueIdentifier: running.task.issueIdentifier } });
    });

    this.scheduler.on('completed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task completed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: result.success, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await reportToDiscord(formatPipelineResultEmbed(result));

      // Track as completed ONLY on success to prevent re-selection (persist to disk)
      if (task.issueId && result.success) {
        this.completedTaskIds.add(task.issueId);
        clearRejection(task.issueId); // Clear rejection count on success
        clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry backoff time
        this.lastFailureDetails.delete(task.issueId); // Stale feedback must not haunt future work
        this.saveTaskState();
        // Track project-level pace (5h rolling window)
        const projectName = task.linearProject?.name ?? 'unknown';
        recordProjectCompletion(projectName, result.totalCost?.costUsd);
      }

      // Skip completion handling for decomposed tasks. Child issues represent the runnable work.
      if (result.finalStatus === 'decomposed') {
        console.log(`[Scheduler] Task decomposed into sub-issues, skipping Done state`);
        this.scheduleNextHeartbeat();
        return;
      }

      // On success, update Linear issue to Done
      if (result.success && task.issueId) {
        try {
          await execution.syncSuccessState(task);
          await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
            workerSummary: result.workerResult?.summary,
            workerCommands: result.workerResult?.commands,
            reviewerFeedback: result.reviewResult?.feedback,
            reviewerDecision: result.reviewResult?.decision,
            testResults: result.testerResult ? {
              passed: result.testerResult.testsPassed,
              failed: result.testerResult.testsFailed,
              coverage: result.testerResult.coverage,
              failedTests: result.testerResult.failedTests,
            } : undefined,
          });
          await execution.reconcileCompletionState(task);
          console.log(`[Scheduler] Issue ${task.issueId} marked as Done`);
        } catch (err) {
          console.error(`[Scheduler] Failed to update issue state:`, err);
        }

        // Accumulate repo-scoped knowledge — recalled and injected into the worker prompt of the next similar task
        const projectPath = result.taskContext?.projectPath;
        if (projectPath) {
          await recordTaskOutcome(projectPath, {
            taskTitle: task.title,
            derivedFrom: task.issueIdentifier ?? task.issueId,
            workerResult: result.workerResult,
            iterations: result.iterations,
          });
        }
      }

      // Linear project Status Update + Overview refresh (non-blocking)
      if (task.linearProject) {
        updateProjectAfterTask(task.linearProject.id, task.linearProject.name, {
          title: task.title,
          success: result.success,
          duration: result.totalDuration,
          issueIdentifier: task.issueIdentifier,
          cost: result.totalCost?.costUsd,
          projectPath: result.taskContext?.projectPath,
        }).catch(e => console.warn('[Scheduler] Project update failed:', e));
      }

      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('cancelled', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task cancelled: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: false, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await execution.syncCancellationState(task);
      // Keep parity with the completed/failed handlers: kick the next heartbeat
      // so discovery resumes immediately instead of waiting for the next cron
      // tick (matters in serial mode, where slotFreed/runAvailableTasks is a no-op).
      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('failed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);

      // Rate-limited: pause execution until the quota resets. Do NOT count it as a
      // task failure, run the rejection/block path, or post a Linear comment —
      // that is exactly the retry-spam this issue fixes. (INT-1906)
      if (result.finalStatus === 'rate_limited') {
        const resetsAt = result.rateLimitResetsAt ?? Date.now() + 60_000;
        this.rateLimitUntil = resetsAt;
        const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
        const resetsLabel = new Date(resetsAt).toISOString();
        console.warn(`[Scheduler] Rate limit hit for ${taskCtx} — pausing until ${resetsLabel} (~${waitSec}s)`);
        broadcastEvent({
          type: 'log',
          data: { taskId: task.issueId || task.id, stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` },
        });
        return;
      }

      // Infra/CLI failure: the worker/reviewer never actually ran (non-zero exit,
      // auth expiry, spawn, timeout). This is NOT a task failure — do NOT increment
      // the rejection/failure counters that mark an issue durably STUCK. Backoff-
      // retry instead; the operator fixes the root cause (e.g. re-auth) and the task
      // resumes on its own. This is what kept completable tasks (worker had already
      // edited files) STUCK in production. (INT-2010)
      if (result.finalStatus === 'infra_error') {
        const detail = result.workerResult?.error || result.reviewResult?.feedback || 'infra/CLI execution error';
        if (task.issueId) {
          // Fixed mid-range backoff — we intentionally don't bump failure counts,
          // so there's no attempt number to scale by.
          const nextRetryTime = setRetryTime(task.issueId, 3, this.failedTaskRetryTimes);
          this.saveTaskState();
          console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK) — backoff retry ${formatRetryTime(nextRetryTime)}: ${detail}`);
        } else {
          console.warn(`[Scheduler] Infra error for ${taskCtx} (NOT counted toward STUCK): ${detail}`);
        }
        this.scheduleNextHeartbeat();
        return;
      }

      console.log(`[Scheduler] Task failed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: false, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await reportToDiscord(formatPipelineResultEmbed(result));

      // Structural infeasibility (⑦, INT-2521): the failure text says the DoD can't
      // be met in this sandbox — it needs a human, a manual step, or an absent
      // environment resource (real DB / live network / production access). The
      // pipeline ran fine and the reviewer *correctly* rejected, so this IS a real
      // task_failure; but re-running against an environmental wall only burns the
      // remaining rejection/failure budget (3–4 full attempts) before the same STUCK.
      // When the task has hit an infeasibility wall on two consecutive attempts, mark
      // it STUCK now — labelled needs-human, blocker surfaced — instead of exhausting
      // the budget. The guard (current AND the previously-recorded failure both carry a
      // high-precision infeasibility marker; the two markers need not be identical) is
      // what keeps a merely-hard task — which keeps making progress and won't stably
      // emit the marker — or a one-off false-positive after an UNRELATED prior failure
      // from being cut early. No new
      // external state: this is the existing STUCK, reached sooner. NOTE: this path
      // intentionally SKIPS the rejection-count / repo-pitfall accounting below — it is
      // a terminal needs-human transition, not a retry, so a rejection tally is moot;
      // it still persists the deciding failure detail. (INT-2521 ⑦)
      if (task.issueId) {
        const infeasDetail = pickFailureDetail([
          result.lastReviewFeedback,
          result.reviewResult?.feedback,
          result.workerResult?.error,
        ]) ?? '';
        const priorDetail = this.lastFailureDetails.get(task.issueId)?.detail ?? '';
        const infeasible = shouldEarlyStuckForInfeasibility(infeasDetail, priorDetail);
        if (infeasible.earlyStuck) {
          const attempts = getRejectionCount(task.issueId) + (this.failedTaskCounts.get(task.issueId) ?? 0) + 1;
          this.completedTaskIds.add(task.issueId); // no retry can move an environmental wall
          clearRetryTime(task.issueId, this.failedTaskRetryTimes);
          clearRejection(task.issueId);
          recordLastFailureDetail(this.taskStateRef, task.issueId, infeasDetail);
          this.saveTaskState();
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }
          try {
            await execution.syncFailureState(task,
              `Needs human — DoD appears unsatisfiable in the sandbox (marker: "${infeasible.marker}") after ${attempts} attempts`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `**Needs human — the DoD appears unsatisfiable in this sandbox.**\n\n` +
              `Detected blocker phrase: "${infeasible.marker}". Re-running can't fix an environmental ` +
              `impossibility (missing DB / network / credentials, or a manual/human step), so automatic ` +
              `retries were stopped early after ${attempts} attempts.\n\n**Latest failure:**\n${infeasDetail}`);
            console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (needs-human: infeasible in sandbox) — ${attempts} attempts`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
          return;
        }
      }

      // If rejected, track rejection count and block after max attempts
      if (task.issueId && result.finalStatus === 'rejected') {
        const feedback = pickFailureDetail([result.lastReviewFeedback, result.reviewResult?.feedback])
          ?? 'No feedback provided';
        const rejectionCount = incrementRejection(task.issueId, feedback);
        // Persist for prompt injection on the retry (same mechanism as failures).
        recordLastFailureDetail(this.taskStateRef, task.issueId, feedback);

        // Store the rejection reason as a repo pitfall (constraint) — blocks repeating the same mistake
        if (result.taskContext?.projectPath) {
          await recordTaskOutcome(result.taskContext.projectPath, {
            taskTitle: task.title,
            derivedFrom: task.issueIdentifier ?? task.issueId,
            rejectionFeedback: feedback,
          });
        }

        console.log(`[Scheduler] Task rejected (${rejectionCount}/3): ${taskCtx} ${task.title}`);
        console.log(`[Scheduler] Rejection reason: ${feedback}`);

        if (isRejectionLimitReached(task.issueId)) {
          // Max rejections reached - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          this.saveTaskState();
          // Terminally stuck → no retry will resume the preserved tree; commit
          // the partial work to the branch and free the disk (INT-2506).
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }

          try {
            await execution.syncFailureState(task, `Max rejection limit reached (${rejectionCount} attempts): ${feedback}`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `Rejected ${rejectionCount} times by the reviewer — automatic retries exhausted.\n\n` +
              `**Latest rejection reason:**\n${feedback}`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (max rejections reached)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
          return;
        } else {
          // Not max yet - schedule retry with exponential backoff
          const nextRetryTime = setRetryTime(task.issueId, rejectionCount, this.failedTaskRetryTimes);
          const retryIn = formatRetryTime(nextRetryTime);
          this.saveTaskState();

          try {
            await execution.syncFailureState(task, `Review rejected (${rejectionCount}/3): ${feedback}`);
            await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
              t('runner.reviewRejected', { feedback }) +
              `\n\n**Rejection count:** ${rejectionCount}/3 - Will retry automatically ${retryIn}.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked as Todo (blocked) (rejected ${rejectionCount}/3) — retry ${retryIn}`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
          return;
        }
      }

      // Track failure count — block after MAX_RETRY_COUNT failures
      if (task.issueId) {
        const count = (this.failedTaskCounts.get(task.issueId) ?? 0) + 1;
        this.failedTaskCounts.set(task.issueId, count);

        // Surface the underlying failure so the stuck comment is actionable AND
        // persist it for the next attempt's injection (INT-2474). Prefer the last
        // REAL reviewer feedback: reviewResult can hold a synthetic entry
        // (validation nudge / HALT overwrite it), and a junk-but-truthy worker
        // error ("Unknown error" from the text-fallback parser) used to mask the
        // reviewer's actionable feedback entirely (INT-2504).
        const failureDetail = pickFailureDetail([
          result.lastReviewFeedback,
          result.reviewResult?.feedback,
          result.workerResult?.error,
        ]) ?? 'No error detail captured (worker produced no output).';
        recordLastFailureDetail(this.taskStateRef, task.issueId, failureDetail);

        if (count >= AutonomousRunner.MAX_RETRY_COUNT) {
          // Max retries exceeded - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          this.saveTaskState();
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx} — STUCK`);
          // Terminally stuck → commit partial work to the branch, free the disk (INT-2506).
          if (result.taskContext?.projectPath) {
            await removePreservedWorktreeAt(result.taskContext.projectPath)
              .catch((err) => console.warn('[Worktree] STUCK cleanup failed:', err));
          }
          try {
            await execution.syncFailureState(task, `Autonomous execution failed ${count} times: ${failureDetail}`);
            await getTaskSource()?.logStuck(task.issueId, 'autonomous-runner',
              `Autonomous execution failed ${count} times in a row — automatic retries exhausted.\n\n` +
              `**Last failure:**\n${failureDetail}`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked STUCK (max retries exceeded)`);
          } catch (err) {
            console.error(`[Scheduler] Failed to update issue state:`, err);
          }
        } else {
          // Schedule retry with exponential backoff
          const nextRetryTime = setRetryTime(task.issueId, count, this.failedTaskRetryTimes);
          const retryIn = formatRetryTime(nextRetryTime);
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx} — retry ${retryIn}`);
          this.saveTaskState();
        }
      }

      // Linear project Status Update + Overview refresh (non-blocking)
      if (task.linearProject) {
        updateProjectAfterTask(task.linearProject.id, task.linearProject.name, {
          title: task.title,
          success: result.success,
          duration: result.totalDuration,
          issueIdentifier: task.issueIdentifier,
          cost: result.totalCost?.costUsd,
          projectPath: result.taskContext?.projectPath,
        }).catch(e => console.warn('[Scheduler] Project update failed:', e));
      }

      this.scheduleNextHeartbeat();
    });

    this.scheduler.on('error', async ({ task, error }) => {
      const taskCtx = this.formatTaskContext(task);
      console.error(`[Scheduler] Task error: ${taskCtx} ${task.title}`, error);
      await reportToDiscord(t('runner.pipelineError', { title: `${taskCtx} ${task.title}`, error: error.message }));
    });

    this.scheduler.on('slotFreed', () => {
      // Auto-execute next task when slot becomes available
      void this.runAvailableTasks();
    });
  }

  private filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[] {
    let recovered = 0;
    let stuckSkipped = 0;
    let backoffSkipped = 0;
    let noProject = 0;
    let unresolvable = 0;
    const toUnstick: string[] = [];
    const filtered = tasks.filter(task => {
      const id = task.issueId || task.id;
      const isStuck = task.labels?.includes(STUCK_LABEL) ?? false;

      // No Linear project → can't be routed to a repo. Drop here (quietly, once per
      // heartbeat) instead of letting a whole batch of project-less Todos reach the
      // per-task selector and spam "No repo mapped to ... undefined" every cycle.
      if (!task.linearProject?.id) {
        noProject++;
        return false;
      }

      // Project resolved to no local repo on a previous heartbeat → don't re-pick
      // it (it would starve runnable tasks behind it). (INT-1875)
      if (this.unresolvableIssueIds.has(id)) {
        unresolvable++;
        return false;
      }

      // Check rejection limit first
      if (isRejectionLimitReached(id)) {
        return false; // Skip tasks that hit max rejection limit
      }

      // Stuck handling (INT-1908): a permanently-blocked issue is parked in Backlog
      // with the `swarm:stuck` label and must NOT be retried automatically. The
      // recovery branch only fires when the user pulls the issue back to an active
      // state — the previous code re-selected it every heartbeat because blocking
      // left it in Todo (a recoverable state), which the recovery branch then
      // mistook for deliberate user intervention.
      const hasFailureHistory = this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT;
      const stuckDecision = classifyStuck({ isStuck, linearState: task.linearState, hasFailureHistory });
      if (stuckDecision === 'recover') {
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id); // Clear rejection count on recovery
        clearRetryTime(id, this.failedTaskRetryTimes); // Clear retry backoff time
        if (isStuck) toUnstick.push(id); // strip the stuck label so it is not re-skipped
        recovered++;
        return true;
      }
      if (stuckDecision === 'skip-stuck') {
        // Durable across restarts: the label lives on the Linear issue, not in the
        // in-memory counters that a restart would lose.
        stuckSkipped++;
        return false;
      }

      if (this.completedTaskIds.has(id)) return false;
      if ((this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT) return false;

      // External-claim guard (INT-1979 dup): an issue set to 'In Progress' that THIS
      // daemon never claimed is owned by a human or another agent — picking it up
      // would re-decompose work someone is already doing (that spawned duplicate
      // INT-1980 sub-issues + a redundant PR). markTaskInProgress writes
      // execution.status='in_progress' when WE claim, so our own in-flight work
      // (incl. resumption after a restart) still passes; a bare Linear 'In Progress'
      // with no local claim record is skipped.
      if (task.linearState === 'In Progress' && getTaskState(id)?.execution?.status !== 'in_progress') {
        return false;
      }

      // Check if task is in exponential backoff period
      if (!canRetryNow(id, this.failedTaskRetryTimes)) {
        backoffSkipped++;
        return false; // Skip tasks still in backoff period
      }

      return true;
    });
    // Strip the stuck label from issues the user pulled back (fire-and-forget — a
    // failed unstick just means the next heartbeat tries again).
    for (const id of toUnstick) {
      getTaskSource()?.unstick(id).catch(err =>
        console.warn(`[AutonomousRunner] Failed to clear stuck label for ${id}:`, err));
    }
    if (stuckSkipped > 0) {
      this.syslog(`🛑 Skipped ${stuckSkipped} stuck issue(s) (retries exhausted — remove the \`${STUCK_LABEL}\` label or move to Todo to retry)`);
    }
    if (recovered > 0) {
      this.saveTaskState();
      this.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
    }
    if (backoffSkipped > 0) {
      this.syslog(`⏰ Skipped ${backoffSkipped} tasks in exponential backoff period`);
    }
    if (noProject > 0) {
      this.syslog(`— Skipped ${noProject} issue(s) with no Linear project (assign a project in Linear to enable)`);
    }
    if (unresolvable > 0) {
      this.syslog(`— Skipped ${unresolvable} issue(s) whose Linear project maps to no local repo (fix the project or add the repo)`);
    }
    return filtered;
  }

  /**
   * Trigger the next heartbeat as soon as possible.
   *
   * Historically this used a "pace-aware cooldown" that grew quadratically
   * with daily completion count (ratio² × 3 multiplier) on top of a 30-minute
   * baseline — the swarm would slow itself down dramatically after a few
   * tasks. That was removed by user request: the cron schedule
   * (`config.heartbeatSchedule`) is now the only knob, and between cron
   * ticks we re-fire immediately when a task wraps up so the next backlog
   * item starts without artificial dead time.
   */
  private _nextHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleNextHeartbeat(): void {
    if (this._nextHeartbeatTimer) return; // already queued
    // Fire on the next event-loop tick so the current scheduler callback
    // returns first (avoids re-entrant heartbeat() while still in `completed`
    // handlers).
    this._nextHeartbeatTimer = setTimeout(() => {
      this._nextHeartbeatTimer = null;
      void this.heartbeat();
    }, 0);
  }

  private async runAvailableTasks(): Promise<void> {
    if (!this.config.pairMode || !this.config.maxConcurrentTasks) {
      return; // Parallel processing disabled
    }

    await this.scheduler.runAvailable(async (task, projectPath, signal) => {
      return this.executePipeline(task, projectPath, signal);
    });
  }

  private getRolesForProject(projectPath: string): DefaultRolesConfig | undefined {
    // Find per-project configuration
    const projectConfig = this.config.projectAgents?.find(
      pa => projectPath.includes(pa.projectPath.replace('~', ''))
    );

    if (!projectConfig?.roles && !this.config.defaultRoles) {
      // Convert from legacy configuration
      return {
        worker: {
          enabled: true,
          model: this.config.workerModel,  // unset → role adapter's getDefaultModel()
          timeoutMs: this.config.workerTimeoutMs ?? 0,
        },
        reviewer: {
          enabled: true,
          model: this.config.reviewerModel,  // unset → role adapter's getDefaultModel()
          timeoutMs: this.config.reviewerTimeoutMs ?? 0,
        },
      };
    }

    // Apply per-project overrides
    const base = this.config.defaultRoles || {
      // No model → each role's adapter resolves its own default (getDefaultModel).
      worker: { enabled: true, timeoutMs: 0 },
      reviewer: { enabled: true, timeoutMs: 0 },
    };

    if (!projectConfig?.roles) {
      return base;
    }

    // Merge overrides
    return {
      worker: { ...base.worker, ...projectConfig.roles.worker },
      reviewer: { ...base.reviewer, ...projectConfig.roles.reviewer },
      tester: projectConfig.roles.tester
        ? { ...base.tester, ...projectConfig.roles.tester }
        : base.tester,
      documenter: projectConfig.roles.documenter
        ? { ...base.documenter, ...projectConfig.roles.documenter }
        : base.documenter,
    } as DefaultRolesConfig;
  }

  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[AutonomousRunner] Already running');
      return;
    }

    await this.engine.init();

    // worktree mode: clean up dangling worktrees at startup
    if (this.config.worktreeMode) {
      for (const projectPath of this.config.allowedProjects) {
        const resolvedPath = projectPath.replace('~', process.env.HOME || '');
        pruneWorktrees(resolvedPath).catch((e) => console.error(`[AutonomousRunner] Worktree prune failed for ${resolvedPath}:`, e));
      }
    }

    // Set up cron job
    this.cronJob = new Cron(this.config.heartbeatSchedule, async () => {
      await this.heartbeat();
    });

    this.state.isRunning = true;
    this.state.startedAt = Date.now();
    console.log(`[AutonomousRunner] Started with schedule: ${this.config.heartbeatSchedule}`);

    await reportToDiscord(`🤖 ${t('runner.modeStarted')}\n` +
      `Schedule: \`${this.config.heartbeatSchedule}\`\n` +
      `Auto-execute: ${this.config.autoExecute ? '✅' : '❌'}\n` +
      `Projects: ${this.config.allowedProjects.join(', ')}`
    );

    // Immediate execution option
    if (this.config.triggerNow) {
      console.log('[AutonomousRunner] Triggering immediate heartbeat in 10s...');
      setTimeout(() => void this.heartbeat(), 10000); // Run after 10s (wait for Discord/Linear connection)
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.state.isRunning = false;
    console.log('[AutonomousRunner] Stopped');
  }

  private buildStats(): SwarmStats {
    const stats = this.scheduler.getStats();
    return {
      runningTasks: stats.running,
      queuedTasks: stats.queued,
      completedToday: stats.completed,
      uptime: this.state.startedAt ? Date.now() - this.state.startedAt : 0,
      schedulerPaused: this.scheduler.isPaused(),
    };
  }

  private refreshKnowledgeGraphs(): void {
    for (const projectPath of this.config.allowedProjects) {
      const resolvedPath = projectPath.replace('~', process.env.HOME || '');
      refreshGraph(resolvedPath).then(graph => {
        if (graph) {
          const slug = toProjectSlug(resolvedPath);
          broadcastEvent({
            type: 'knowledge:updated',
            data: { projectSlug: slug, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount },
          });
        }
      }).catch((e) => {
        console.error(`[AutonomousRunner] Knowledge graph refresh failed for ${resolvedPath}:`, e);
      });
    }
  }

  /** Send system message to dashboard LIVE LOG */
  private syslog(line: string): void {
    console.log(`[HB] ${line}`);
    broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'heartbeat', line } });
  }

  private lastSkipSummary = '';

  /**
   * Log unmapped/disabled project skips as one aggregate line per category,
   * and stay silent while the summary is identical to the previous heartbeat.
   */
  private syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void {
    const fmt = (m: Map<string, number>) => [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} (${n})`)
      .join(', ');
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    if (unmapped.size > 0) {
      lines.push(`  ⚠ Skipped ${total(unmapped)} issue(s) in ${unmapped.size} unmapped project(s): ${fmt(unmapped)} — run \`openswarm add\` to map`);
    }
    if (disabled.size > 0) {
      lines.push(`  ⚠ Skipped ${total(disabled)} issue(s) in ${disabled.size} disabled project(s): ${fmt(disabled)}`);
    }
    const summary = lines.join('\n');
    if (summary === this.lastSkipSummary) return;
    this.lastSkipSummary = summary;
    for (const line of lines) this.syslog(line);
  }

  private async groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> {
    const byProjectId = new Map<string, string>();
    for (const repoPath of this.config.allowedProjects) {
      try {
        const resolvedPath = repoPath.replace('~', process.env.HOME || '');
        const meta = await loadRepoMetadata(resolvedPath);
        if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, resolvedPath);
      } catch {
        // Grooming is advisory; unreadable metadata should not block normal work.
      }
    }

    const groups = new Map<string, TaskItem[]>();
    for (const task of tasks) {
      const projectPath = task.projectPath
        ?? (task.linearProject?.id ? byProjectId.get(task.linearProject.id) : undefined)
        ?? undefined;
      if (!projectPath) continue;
      const list = groups.get(projectPath) ?? [];
      list.push(task);
      groups.set(projectPath, list);
    }
    return groups;
  }

  private async maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]> {
    const cfg = this.config.backlogGrooming;
    if (!cfg?.enabled) return tasks;

    const cadenceMs = Math.max(1, cfg.cadenceHours ?? 24) * 60 * 60 * 1000;
    const now = Date.now();
    if (this.lastBacklogGroomingAt && now - this.lastBacklogGroomingAt < cadenceMs) return tasks;

    const source = getTaskSource();
    if (!source) {
      this.syslog('⚠ Backlog grooming skipped: no task source');
      return tasks;
    }

    const groomable = filterGroomableTasks(tasks);
    if (groomable.length === 0) return tasks;

    const mode = cfg.mode ?? 'comment';
    const moved = new Set<string>();
    const groups = await this.groupTasksForGrooming(groomable);
    if (groups.size === 0) {
      this.syslog('⚠ Backlog grooming skipped: no mapped project paths');
      return tasks;
    }

    let successfulPlannerRuns = 0;
    for (const [projectPath, groupTasks] of groups) {
      this.syslog(`⟳ Backlog grooming: ${groupTasks.length} issue(s) in ${projectPath.split('/').pop()}`);
      const result = await runBacklogGroomingPlanner({
        tasks: groupTasks,
        projectPath,
        projectName: groupTasks[0]?.linearProject?.name,
        model: cfg.plannerModel ?? this.config.plannerModel,
        timeoutMs: cfg.plannerTimeoutMs ?? this.config.plannerTimeoutMs,
        maxIssues: cfg.maxIssues,
        onLog: (line) => broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'groom', line } }),
      });
      if (!result.success) {
        this.syslog(`⚠ Backlog grooming failed: ${result.error ?? 'unknown error'}`);
        continue;
      }
      successfulPlannerRuns++;
      const validIssueIds = new Set(groupTasks.map(task => task.issueId || task.id));
      const applied = await applyBacklogGrooming(source, result, mode, validIssueIds);
      for (const issueId of applied.movedIssueIds) moved.add(issueId);
      this.syslog(`✓ Backlog grooming: ${result.decisions.length} decision(s), ${applied.commented} comment(s), ${applied.failedComments} comment failure(s), ${applied.updatedDescriptions} description update(s), ${applied.moved} moved, ${applied.skippedUnknown} unknown skipped`);
      for (const decision of result.decisions.slice(0, 5)) {
        this.syslog(`  ${summarizeGroomingDecision(decision)}`);
      }
    }

    if (successfulPlannerRuns > 0) this.lastBacklogGroomingAt = now;
    if (moved.size === 0) return tasks;
    return tasks.filter(task => !moved.has(task.issueId || task.id));
  }

  async heartbeat(): Promise<void> {
    if (this._heartbeatRunning) {
      console.log('[AutonomousRunner] Heartbeat already running, skipping');
      return;
    }
    this._heartbeatRunning = true;

    console.log('[AutonomousRunner] Heartbeat triggered');
    this.state.lastHeartbeat = Date.now();
    broadcastEvent({ type: 'stats', data: this.buildStats() });
    broadcastEvent({ type: 'heartbeat' });
    this.syslog('▶ Heartbeat started');

    try {
      // 0. Knowledge graph refresh (async, service continues even on failure)
      this.refreshKnowledgeGraphs();

      // 0.1 Sweep orphan worktrees every heartbeat (crashed/cancelled leftovers),
      // never the worktree of a currently-running task. Startup does a full sweep;
      // this keeps repos from accumulating worktree/ dirs between restarts.
      if (this.config.worktreeMode) {
        const activeWorktrees = new Set(
          this.scheduler.getRunningTasks().map((r) => `${r.projectPath}/worktree/${r.task.issueId}`),
        );
        for (const projectPath of this.config.allowedProjects) {
          const resolvedPath = projectPath.replace('~', process.env.HOME || '');
          pruneWorktrees(resolvedPath, activeWorktrees).catch((e) =>
            console.error(`[AutonomousRunner] Worktree sweep failed for ${resolvedPath}:`, e),
          );
        }
      }

      // 0.5 Long-running monitor passive check (before time window)
      const active = getActiveMonitors().filter(m => m.state === 'pending' || m.state === 'running');
      if (active.length > 0) {
        const checked = await checkAllMonitors().catch(() => 0);
        this.syslog(`✓ Monitors: ${checked} checked / ${active.length} active`);
      }

      // 1. Check time window
      const timeCheck = checkWorkAllowed();
      if (!timeCheck.allowed) {
        console.log(`[AutonomousRunner] Blocked: ${timeCheck.reason}`);
        this.syslog(`⛔ Time window blocked: ${timeCheck.reason}`);
        return;
      }
      this.syslog('✓ Time window: allowed');

      // 1.2 Rate-limit hold — skip the heartbeat while a 429 pause is still active.
      // Cleared implicitly once the clock passes rateLimitUntil. (INT-1906)
      if (Date.now() < this.rateLimitUntil) {
        const remainSec = Math.max(0, Math.ceil((this.rateLimitUntil - Date.now()) / 1000));
        const resetsLabel = new Date(this.rateLimitUntil).toISOString();
        console.log(`[AutonomousRunner] Rate limit hold active — ${remainSec}s remaining (until ${resetsLabel})`);
        this.syslog(`⏸ Rate limit hold: ~${remainSec}s remaining`);
        broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'rate_limit', line: `⏸ Rate limit hold: ~${remainSec}s remaining` } });
        return;
      }

      // 1.5 Quota gate (removed) — was a Claude Max quota check (api.anthropic.com
      // /oauth/usage). OpenSwarm runs codex-responses now, not claude -p, so a Claude
      // quota gate is irrelevant; it only spammed 401s and could wrongly skip codex
      // work. codex-responses self-protects via RateLimitError (scheduler pause).

      // 1.6 Pace gate (removed)
      // The 5h rolling window cap (globalCap = projects × dailyTaskCap) and
      // turbo-mode multiplier used to gate heartbeat here. Both were removed
      // by user request: speed is now governed only by the cron schedule and
      // the Linear API rate limiter, not by an internal completion cap.
      this.syslog(`✓ Pace: unrestricted (cron only)`);

      // 2. Fetch tasks from Linear
      this.syslog('⟳ Fetching tasks from Linear...');
      const fetchResult = await fetchLinearTasks();
      if (fetchResult.error) {
        this.syslog(`✗ Linear fetch error: ${fetchResult.error}`);
        await reportToDiscord(`⚠️ Linear fetch failed: ${fetchResult.error}`);
        return;
      }
      let tasks = fetchResult.tasks;
      if (tasks.length === 0) {
        this.syslog('— No tasks in backlog');
        return;
      }

      this.lastFetchedTasks = tasks;
      this.syslog(`✓ Found ${tasks.length} tasks from Linear`);

      tasks = await this.maybeRunBacklogGrooming(tasks);
      this.lastFetchedTasks = tasks;
      if (tasks.length === 0) {
        this.syslog('— No executable tasks after backlog grooming');
        return;
      }

      // Filter out completed and over-retried tasks
      const filteredTasks = this.filterAlreadyProcessed(tasks);
      if (filteredTasks.length === 0) {
        this.syslog('— All tasks already completed or max retries exceeded');
        return;
      }
      if (filteredTasks.length !== tasks.length) {
        this.syslog(`  Filtered: ${tasks.length} → ${filteredTasks.length} (skipped ${tasks.length - filteredTasks.length} completed/failed)`);
      }

      // Parallel processing mode
      if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1 && this.config.pairMode) {
        await this.heartbeatParallel(filteredTasks);
        return;
      }

      // 3. Run Decision Engine (single task)
      this.syslog('⟳ Running Decision Engine...');
      const decision = await this.engine.heartbeat(filteredTasks);
      this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      this.state.lastDecision = decision;

      // 4. Handle decision
      if (decision.action === 'execute' && decision.task) {
        await this.executeTaskPairMode(decision.task);
      } else if (decision.action === 'defer' && decision.task) {
        this.state.pendingApproval = decision.task;
        await this.requestApproval(decision);
      }
      this.state.consecutiveErrors = 0;

    } catch (error) {
      this.state.consecutiveErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[AutonomousRunner] Heartbeat error:', msg);
      this.syslog(`✗ Heartbeat error: ${msg}`);

      if (this.state.consecutiveErrors >= 3) {
        await reportToDiscord(t('runner.consecutiveErrors', { count: this.state.consecutiveErrors, error: msg }));
      }
    } finally {
      this._heartbeatRunning = false;
    }
  }

  private async heartbeatParallel(tasks: TaskItem[]): Promise<void> {
    const availableSlots = this.scheduler.getAvailableSlots();
    const runningCount = this.scheduler.getStats().running;
    this.syslog(`  Parallel mode | slots: ${availableSlots} free / ${this.config.maxConcurrentTasks} max | running: ${runningCount}`);

    if (availableSlots === 0) {
      this.syslog(`⏳ All slots busy (${runningCount} tasks running), waiting...`);
      return;
    }

    // Fill all available slots (worktree mode isolates each task)
    const maxSlots = availableSlots;

    // Pre-filter tasks to enabled projects only (before DecisionEngine selection)
    // This prevents DecisionEngine from wasting its max-slot budget on non-enabled projects.
    // Only execute Todo tasks; Backlog is fetched for dashboard display only
    const executableTasks = tasks.filter(t => t.linearState !== 'Backlog');

    let tasksForEngine = executableTasks;
    if (this.shouldFilterByEnabled()) {
      // Explicit repo↔Linear mapping — match fetched issues to repos by the Linear
      // projectId the user picked in `openswarm add` (written to <repo>/openswarm.json),
      // NOT by guessing from the repo directory name. Built fresh each cycle so a
      // newly-mapped repo is picked up without a restart. Name matching stays only as
      // a best-effort fallback for repos that never ran the picker.
      const byProjectId = new Map<string, string>();
      for (const repoPath of this.enabledProjects) {
        try {
          const meta = await loadRepoMetadata(repoPath);
          if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, repoPath);
        } catch (e) {
          this.syslog(`  ⚠ openswarm.json unreadable for ${repoPath.split('/').pop()}: ${(e as Error).message}`);
        }
      }

      // Aggregate skip reasons per project instead of logging one line per issue —
      // dozens of unmapped issues used to flood the LIVE LOG every heartbeat.
      const skippedUnmapped = new Map<string, number>();
      const skippedDisabled = new Map<string, number>();
      tasksForEngine = executableTasks.filter(task => {
        const projName = task.linearProject?.name;
        const projId = task.linearProject?.id;
        // 1) Explicit projectId mapping (openswarm.json) wins.
        const mappedPath = projId ? byProjectId.get(projId) : undefined;
        // 2) Fallback: repo-name path cache (only for repos without an explicit mapping).
        const cachedPath = mappedPath
          ?? (projName && (this.projectPathCache.get(projName)
            ?? this.projectPathCache.get(projName.toLowerCase())
            ?? this.projectPathCache.get(projName.replace(/-/g, ' '))));
        if (!cachedPath) {
          const key = projName ?? projId ?? 'unknown';
          skippedUnmapped.set(key, (skippedUnmapped.get(key) ?? 0) + 1);
          return false;
        }
        const enabled = this.isProjectEnabled(cachedPath);
        if (!enabled) {
          skippedDisabled.set(projName ?? cachedPath, (skippedDisabled.get(projName ?? cachedPath) ?? 0) + 1);
        }
        return enabled;
      });
      this.syslogSkipSummary(skippedUnmapped, skippedDisabled);
      if (tasksForEngine.length === 0) {
        this.syslog(`⚠ No enabled tasks (${executableTasks.length} executable, ${tasks.length - executableTasks.length} backlog)`);
        this.syslog(`  Path cache: [${[...this.projectPathCache.entries()].map(([k,v]) => `${k}→${v}`).join(', ')}]`);
        this.syslog(`  Enabled: [${[...this.enabledProjects].join(', ')}]`);
        return;
      }
      this.syslog(`  Tasks: ${tasksForEngine.length} enabled-or-uncached / ${executableTasks.length} executable / ${tasks.length} total`);
    }

    let enqueuedCount = 0;
    let skippedCount = 0;
    const consideredTaskIds = new Set<string>();
    let pass = 0;

    while (enqueuedCount < maxSlots) {
      const remainingSlots = maxSlots - enqueuedCount;
      const selectableTasks = tasksForEngine.filter(task => !consideredTaskIds.has(task.id));
      const selectionBudget = decisionSelectionBudget(remainingSlots, selectableTasks.length);
      if (selectionBudget === 0) break;

      this.syslog(pass === 0
        ? '⟳ Decision Engine evaluating tasks...'
        : `⟳ Backfill pass (${remainingSlots} slot(s) open)...`);

      const decision = await this.engine.heartbeatMultiple(
        selectableTasks,
        selectionBudget,
        [] // No project exclusion — worktree mode isolates each task
      );

      console.log(`[AutonomousRunner] Decision: ${decision.action} — ${decision.reason} (${decision.tasks?.length ?? 0} tasks)`);
      skippedCount += decision.skippedCount ?? 0;
      if (decision.action === 'skip' || decision.action === 'defer') {
        this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
        break;
      }

      for (const { task } of decision.tasks) {
        consideredTaskIds.add(task.id);
      }

      const candidates = await this.resolveRunnableCandidates(decision.tasks);
      const safeTasks = await this.detectSafeCandidateIds(candidates);
      const before = enqueuedCount;

      for (const { task, projectPath } of candidates) {
        if (enqueuedCount >= maxSlots) break;
        if (!safeTasks.has(task.id)) continue;
        if (!this.canQueueProjectCandidate(projectPath)) {
          this.syslog(`  Project cap reached: ${projectPath}`);
          continue;
        }

        this.enqueueCandidate(task, projectPath);
        enqueuedCount++;
      }

      pass++;

      if (enqueuedCount >= maxSlots) break;
      if (decision.tasks.length === 0) break;
      if (selectionBudget >= selectableTasks.length) break;
      if (enqueuedCount === before) continue;
    }

    if (enqueuedCount === 0 && skippedCount > 0) {
      this.syslog(`— No new tasks queued (skipped: ${skippedCount})`);
    } else {
      this.syslog(`✓ Enqueued ${enqueuedCount} task(s) | skipped: ${skippedCount}`);
    }

    // Execute tasks
    await this.runAvailableTasks();
  }

  private async resolveRunnableCandidates(decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]> {
    const candidates: { task: TaskItem; projectPath: string }[] = [];
    for (const { task } of decisionTasks) {
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        this.syslog(`  Skip (already queued/running): ${task.issueIdentifier || task.id.slice(0, 8)} ${task.title}`);
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);
      if (!projectPath) {
        this.syslog(`✗ Cannot resolve project path for "${task.linearProject?.name || task.title}" — skipping`);
        // Record so it isn't re-picked every heartbeat (starvation). (INT-1875)
        this.unresolvableIssueIds.add(task.issueId || task.id);
        continue;
      }

      if (task.linearProject?.name) {
        this.projectPathCache.set(task.linearProject.name, projectPath);
      }

      if (this.scheduler.isProjectBusy(projectPath)) {
        this.syslog(`  Project busy: ${projectPath}`);
        continue;
      }

      if (this.shouldFilterByEnabled() && !this.isProjectEnabled(projectPath)) {
        this.syslog(`  Project not enabled: ${projectPath}`);
        continue;
      }

      // Per-project 5h window cap (removed, INT-2317) — like the global pace
      // gate above, throughput is governed by the cron schedule and the Linear
      // rate limiter only. Completions are still recorded for cost telemetry.
      candidates.push({ task, projectPath });
    }

    return candidates;
  }

  private async detectSafeCandidateIds(candidates: RunnableCandidate[]): Promise<Set<string>> {
    // Group candidates by projectPath for conflict detection
    const byProject = new Map<string, { task: TaskItem; projectPath: string }[]>();
    for (const c of candidates) {
      const group = byProject.get(c.projectPath) || [];
      group.push(c);
      byProject.set(c.projectPath, group);
    }

    // Detect file conflicts per project using Knowledge Graph
    const safeTasks = new Set<string>(); // task IDs safe to enqueue
    for (const [projPath, group] of byProject) {
      if (group.length <= 1) {
        // 단일 태스크 → 충돌 없음
        for (const c of group) safeTasks.add(c.task.id);
        continue;
      }

      try {
        const result = await detectFileConflicts(group.map(c => c.task), projPath);

        for (const t of result.safe) {
          safeTasks.add(t.id);
        }

        for (const cg of result.conflictGroups) {
          const ids = cg.tasks.map(t => t.issueIdentifier || t.id.slice(0, 8)).join(', ');
          this.syslog(`Conflict group: [${ids}] shared: ${cg.sharedModules.join(', ')}`);
          // 충돌 그룹의 연기된 태스크 로그
          for (const t of cg.tasks) {
            if (!safeTasks.has(t.id)) {
              this.syslog(`Conflict detected — deferring: ${t.issueIdentifier || t.id.slice(0, 8)} ${t.title}`);
            }
          }
        }
      } catch (err) {
        // KG 분석 실패 시 모든 태스크를 safe로 처리 (graceful degradation)
        console.warn(`[AutonomousRunner] Conflict detection failed for ${projPath}:`, err);
        for (const c of group) safeTasks.add(c.task.id);
      }
    }

    return safeTasks;
  }

  /**
   * Re-attempt of a previously failed/rejected issue: carry the last failure
   * feedback into the run so the worker's first iteration addresses it instead
   * of repeating the same mistake blind (INT-2474). Called on BOTH execution
   * paths — parallel enqueue and the serial (maxConcurrentTasks=1) heartbeat.
   */
  private attachPriorFeedback(task: TaskItem): void {
    if (!task.issueId) return;
    const prior = this.lastFailureDetails.get(task.issueId);
    if (prior) task.priorAttemptFeedback = prior.detail;
  }

  private enqueueCandidate(task: TaskItem, projectPath: string): void {
    this.attachPriorFeedback(task);
    this.scheduler.enqueue(task, projectPath);
    broadcastEvent({ type: 'task:queued', data: { taskId: task.id, title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
    this.syslog(`✓ Queued: ${task.issueIdentifier || ''} ${task.title} → ${projectPath.split('/').slice(-2).join('/')}`);

    // Claim the task immediately: set Linear to 'In Progress' so restarts don't re-queue it
    if (task.issueId) {
      getTaskSource()?.updateState(task.issueId, 'In Progress').catch((err: Error) =>
        console.warn(`[AutonomousRunner] Failed to claim issue ${task.issueIdentifier}:`, err)
      );
    }
  }

  /** Execute task in pair mode */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    // Serial path (maxConcurrentTasks=1) bypasses enqueueCandidate — attach the
    // prior-session feedback here too so both paths inject it (INT-2474).
    this.attachPriorFeedback(task);

    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      // Record so this issue isn't re-picked every heartbeat (it would starve
      // runnable tasks behind it). Cleared on restart. (INT-1875)
      this.unresolvableIssueIds.add(task.issueId || task.id);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      // Move on to the next actionable task instead of ending the heartbeat here.
      this.scheduleNextHeartbeat();
      return;
    }

    // Skip if project is not in enabled list (allow-list; empty = nothing runs)
    if (this.shouldFilterByEnabled() && !this.isProjectEnabled(projectPath)) {
      console.log(`[AutonomousRunner] Project not enabled, skipping: ${projectPath}`);
      return;
    }

    // Cache linearProjectName → resolvedPath for dashboard
    if (task.linearProject?.name) {
      this.projectPathCache.set(task.linearProject.name, projectPath);
    }

    console.log(`[AutonomousRunner] projectPath: ${projectPath}`);

    // Check task decomposition (when enableDecomposition is set)
    if (this.config.enableDecomposition) {
      const threshold = this.config.decompositionThresholdMinutes ?? 30;
      const needsDecomp = planner.needsDecomposition(task, threshold);

      if (needsDecomp) {
        console.log(`[AutonomousRunner] Task "${task.title}" needs decomposition (>${threshold}min estimated)`);
        const decomposed = await this.decomposeTask(task, projectPath, threshold);
        if (decomposed) {
          // Decomposition succeeded - sub-tasks added to queue, skip original task
          return;
        }
        // Decomposition failed - execute original task as-is
        console.log('[AutonomousRunner] Decomposition failed, executing original task');
      }
    }

    // Use scheduler for parallel processing mode
    if (this.config.maxConcurrentTasks && this.config.maxConcurrentTasks > 1) {
      this.scheduler.enqueue(task, projectPath);
      broadcastEvent({ type: 'task:queued', data: { taskId: task.id, title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      await this.runAvailableTasks();
      return;
    }

    // Single execution (legacy)
    const result = await this.executePipeline(task, projectPath);

    // Rate-limited: pause until quota resets. Return before any Discord/Linear
    // reporting or state change — no failure count, no card spam. Same as the
    // scheduler 'failed' handler's rate_limited branch. (INT-1906)
    if (result.finalStatus === 'rate_limited') {
      const resetsAt = result.rateLimitResetsAt ?? Date.now() + 60_000;
      this.rateLimitUntil = resetsAt;
      const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
      const resetsLabel = new Date(resetsAt).toISOString();
      console.warn(`[AutonomousRunner] Rate limit hit for ${this.formatTaskContext(task)} — pausing until ${resetsLabel} (~${waitSec}s)`);
      broadcastEvent({ type: 'log', data: { taskId: task.issueId || task.id, stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` } });
      return;
    }

    await reportToDiscord(formatPipelineResultEmbed(result));

    // Update Linear issue state
    if (task.issueId) {
      try {
        if (result.success) {
          // On success, move to Done
          await execution.syncSuccessState(task);
          await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, {
            attempts: result.iterations,
            duration: Math.floor(result.totalDuration / 1000),
            filesChanged: result.workerResult?.filesChanged || [],
            workerSummary: result.workerResult?.summary,
            workerCommands: result.workerResult?.commands,
            reviewerFeedback: result.reviewResult?.feedback,
            reviewerDecision: result.reviewResult?.decision,
            testResults: result.testerResult ? {
              passed: result.testerResult.testsPassed,
              failed: result.testerResult.testsFailed,
              coverage: result.testerResult.coverage,
              failedTests: result.testerResult.failedTests,
            } : undefined,
          });
          await execution.reconcileCompletionState(task);
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Done`);

          if (result.taskContext?.projectPath) {
            await recordTaskOutcome(result.taskContext.projectPath, {
              taskTitle: task.title,
              derivedFrom: task.issueIdentifier ?? task.issueId,
              workerResult: result.workerResult,
              iterations: result.iterations,
            });
          }
        } else if (result.finalStatus === 'rejected') {
          // Change to Blocked on review rejection
          await execution.syncFailureState(
            task,
            `Review rejected: ${result.reviewResult?.feedback || t('common.fallback.noDescription')}`
          );
          await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
            t('runner.reviewRejected', { feedback: result.reviewResult?.feedback || t('common.fallback.noDescription') })
          );
          console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Todo (blocked) (rejected)`);
        }
        // If failed, keep In Progress (retry on next heartbeat)
      } catch (err) {
        console.error(`[AutonomousRunner] Failed to update issue state:`, err);
      }
    }
  }

  private getExecCtx(): execution.ExecutionContext {
    return {
      allowedProjects: this.config.allowedProjects,
      plannerModel: this.config.plannerModel,
      plannerTimeoutMs: this.config.plannerTimeoutMs,
      pairMaxAttempts: this.config.pairMaxAttempts,
      enableDecomposition: this.config.enableDecomposition,
      decompositionThresholdMinutes: this.config.decompositionThresholdMinutes,
      decompositionMaxDepth: this.config.decomposition?.maxDepth ?? 2,
      decompositionMaxChildren: this.config.decomposition?.maxChildrenPerTask ?? 5,
      decompositionDailyLimit: this.config.decomposition?.dailyLimit ?? 20,
      decompositionAutoBacklog: this.config.decomposition?.autoBacklog ?? true,
      jobProfiles: this.config.jobProfiles,
      getRolesForProject: (p) => this.getRolesForProject(p),
      reportToDiscord,
      worktreeMode: this.config.worktreeMode ?? false,
      scheduleNextHeartbeat: () => this.scheduleNextHeartbeat(),
      guards: this.config.guards,
      maxReflections: this.config.maxReflections,
    };
  }

  private async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  private async decomposeTask(task: TaskItem, projectPath: string, targetMinutes: number): Promise<boolean | 'no-decomp'> {
    return execution.decomposeTask(this.getExecCtx(), task, projectPath, targetMinutes);
  }

  private async executePipeline(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult> {
    return execution.executePipeline(this.getExecCtx(), task, projectPath, signal);
  }

  private async requestApproval(decision: DecisionResult): Promise<void> {
    return execution.requestApproval(decision, reportToDiscord);
  }

  async approve(): Promise<boolean> {
    if (!this.state.pendingApproval) {
      return false;
    }

    const task = this.state.pendingApproval;
    this.state.pendingApproval = undefined;

    // Get workflow from Decision Engine
    const decision = await this.engine.heartbeat([task]);
    if (decision.workflow && decision.task) {
      await this.executeTaskPairMode(decision.task);
      return true;
    }

    return false;
  }

  reject(): boolean {
    if (!this.state.pendingApproval) {
      return false;
    }

    this.state.pendingApproval = undefined;
    return true;
  }

  async runNow(): Promise<void> {
    await this.heartbeat();
  }

  getState(): RunnerState {
    return { ...this.state };
  }

  getAllowedProjects(): string[] {
    return this.config.allowedProjects ?? [];
  }

  updateAllowedProjects(paths: string[]): void {
    this.config.allowedProjects = paths;
    this.engine.updateAllowedProjects(paths);
  }

  getStats() {
    return { isRunning: this.state.isRunning, lastHeartbeat: this.state.lastHeartbeat,
      engineStats: this.engine.getStats(), pendingApproval: !!this.state.pendingApproval,
      schedulerStats: this.scheduler.getStats(),
      turboMode: this.turboMode,
      turboExpiresAt: this.turboExpiresAt,
      dailyPace: getDailyPaceInfo(),
    };
  }

  // ============================================
  // Max Pace (formerly "Turbo")
  // ============================================

  getTurboMode(): boolean {
    // Max pace no longer auto-expires; it stays on until explicitly toggled off.
    return this.turboMode;
  }

  setTurboMode(enabled: boolean): void {
    this.turboMode = enabled;
    // No auto-expiry: max pace is a persistent state, not a 4h burst. (always-max)
    this.turboExpiresAt = null;
    if (enabled) {
      console.log('[AutonomousRunner] MAX PACE ON (persistent)');
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: 'MAX PACE ON — persistent' } });
    } else {
      console.log('[AutonomousRunner] MAX PACE OFF');
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: 'MAX PACE OFF — normal pace resumed' } });
    }
  }

  async getAdapterSummary() {
    const defaultAdapter = this.config.defaultAdapter ?? 'codex';
    const defaultRoles = this.config.defaultRoles;
    const workerAdapter = defaultRoles?.worker?.adapter ?? defaultAdapter;
    const reviewerAdapter = defaultRoles?.reviewer?.adapter ?? defaultAdapter;

    return {
      defaultAdapter,
      worker: {
        adapter: workerAdapter,
        // Resolve the adapter's real default when config omits the model, so the
        // dashboard's PAIR bar shows what's running instead of "-". (INT-2393)
        model: defaultRoles?.worker?.model ?? this.config.workerModel
          ?? await resolveAdapterDefaultModel(workerAdapter, this.defaultModelCache),
        enabled: defaultRoles?.worker?.enabled !== false,
      },
      reviewer: {
        adapter: reviewerAdapter,
        model: defaultRoles?.reviewer?.model ?? this.config.reviewerModel
          ?? await resolveAdapterDefaultModel(reviewerAdapter, this.defaultModelCache),
        enabled: defaultRoles?.reviewer?.enabled !== false,
      },
      tester: defaultRoles?.tester ? {
        adapter: defaultRoles.tester.adapter ?? defaultAdapter,
        model: defaultRoles.tester.model,
        enabled: defaultRoles.tester.enabled !== false,
      } : undefined,
      documenter: defaultRoles?.documenter ? {
        adapter: defaultRoles.documenter.adapter ?? defaultAdapter,
        model: defaultRoles.documenter.model,
        enabled: defaultRoles.documenter.enabled !== false,
      } : undefined,
    };
  }

  switchProvider(adapter: AdapterName): void {
    // On a provider switch, keep the model only if it clearly belongs to the new
    // provider; otherwise drop it (undefined) so the target adapter resolves its
    // own default via getDefaultModel(). Shared with the planner's model guard
    // (src/adapters/modelCompat.ts) so both stay in sync. (INT-2510)
    const mapModelForProvider = (model: string | undefined, _role?: string): string | undefined =>
      mapModelForAdapter(adapter, model);

    this.config.defaultAdapter = adapter;

    if (this.config.defaultRoles) {
      this.config.defaultRoles.worker = {
        ...this.config.defaultRoles.worker,
        adapter,
        model: mapModelForProvider(this.config.defaultRoles.worker.model, 'worker'),
      };
      this.config.defaultRoles.reviewer = {
        ...this.config.defaultRoles.reviewer,
        adapter,
        model: mapModelForProvider(this.config.defaultRoles.reviewer.model, 'reviewer'),
      };

      if (this.config.defaultRoles.tester) {
        this.config.defaultRoles.tester = {
          ...this.config.defaultRoles.tester,
          adapter,
          model: mapModelForProvider(this.config.defaultRoles.tester.model, 'tester'),
        };
      }
      if (this.config.defaultRoles.documenter) {
        this.config.defaultRoles.documenter = {
          ...this.config.defaultRoles.documenter,
          adapter,
          model: mapModelForProvider(this.config.defaultRoles.documenter.model, 'documenter'),
        };
      }
      if (this.config.defaultRoles.auditor) {
        this.config.defaultRoles.auditor = {
          ...this.config.defaultRoles.auditor,
          adapter,
          model: mapModelForProvider(this.config.defaultRoles.auditor.model, 'auditor'),
        };
      }
      if (this.config.defaultRoles['skill-documenter']) {
        this.config.defaultRoles['skill-documenter'] = {
          ...this.config.defaultRoles['skill-documenter'],
          adapter,
          model: mapModelForProvider(this.config.defaultRoles['skill-documenter'].model, 'skill-documenter'),
        };
      }
    }

    if (this.config.workerModel) {
      this.config.workerModel = mapModelForProvider(this.config.workerModel, 'worker');
    }
    if (this.config.reviewerModel) {
      this.config.reviewerModel = mapModelForProvider(this.config.reviewerModel, 'reviewer');
    }
    // The decomposition planner is a role too. Leaving it unmapped sent the
    // config's codex id straight into `claude -p --model gpt-5.5` — a fast 404
    // that killed EVERY decomposition on the new provider. (INT-2510)
    if (this.config.plannerModel) {
      this.config.plannerModel = mapModelForProvider(this.config.plannerModel, 'planner');
    }

    // jobProfiles ALSO pin per-role models (config's light/heavy → e.g. qwen), and getModelForRole
    // gives the profile model precedence over defaultRoles. Remapping only defaultRoles left every
    // estimate-matched task on its old provider's model → "I switched to Codex but it still uses the
    // old provider". Remap the profiles too: an incompatible id becomes undefined so the adapter
    // falls back to its OWN default model.
    if (this.config.jobProfiles) {
      for (const profile of this.config.jobProfiles) {
        if (!profile.roles) continue;
        for (const role of Object.keys(profile.roles) as Array<keyof typeof profile.roles>) {
          const mapped = mapModelForProvider(profile.roles[role], role);
          if (mapped === undefined) delete profile.roles[role];
          else profile.roles[role] = mapped;
        }
      }
    }

    // Persist the choice so a daemon restart keeps it (in-memory switch was lost every restart).
    writeProviderOverride(adapter);
    console.log(`[AutonomousRunner] Provider switched: ${adapter}`);
  }

  pauseScheduler(): void { this.scheduler.pause(); }
  resumeScheduler(): void { this.scheduler.resume(); }
  getQueuedTasks() { return this.scheduler.getQueuedTasks(); }
  getRunningTasks() { return this.scheduler.getRunningTasks(); }
  getPipelineHistory(limit = 50) { return getPipelineHistory(limit); }

  private recordPipelineHistory(task: TaskItem, result: PipelineResult): void {
    appendPipelineHistory({
      sessionId: result.sessionId, issueIdentifier: task.issueIdentifier || task.issueId,
      issueId: task.issueId, taskTitle: task.title, projectName: task.linearProject?.name,
      projectPath: result.taskContext?.projectPath, success: result.success,
      finalStatus: result.finalStatus, iterations: result.iterations,
      totalDuration: result.totalDuration,
      stages: result.stages.map(s => ({ stage: s.stage, success: s.success, duration: s.duration })),
      cost: result.totalCost ? { costUsd: result.totalCost.costUsd,
        inputTokens: result.totalCost.inputTokens, outputTokens: result.totalCost.outputTokens } : undefined,
      prUrl: result.prUrl, reviewerFeedback: result.reviewResult?.feedback,
      completedAt: new Date().toISOString(),
    });
  }

  disableProject(projectPath: string): void {
    this.projectSelectionTouched = true; // empty set now means "nothing runs" (INT-2207)
    this.enabledProjects.delete(projectPath);
    console.log(`[AutonomousRunner] Project disabled: ${projectPath}`);
    // Disabling gates new selection AND cancels any in-flight pipeline for this
    // project — otherwise a running task keeps working a now-disabled repo.
    const cancelled = this.scheduler.cancelProjectTasks(projectPath);
    if (cancelled > 0) {
      this.syslog(`⏹ Cancelled ${cancelled} in-flight task(s) for disabled project ${projectPath.split('/').pop()}`);
    }
    this.persistSelection();
  }

  enableProject(projectPath: string): void {
    this.projectSelectionTouched = true; // explicit selection from here on (INT-2207)
    this.enabledProjects.add(projectPath);
    // Enabling a repo (via `openswarm add` / the dashboard) must also ALLOW it:
    // resolveProjectPath only reads a repo's openswarm.json for paths in
    // allowedProjects, so an enabled-but-not-allowed repo never resolves
    // ("No repo mapped"). Keep config + DecisionEngine in sync. (INT-1970)
    const allowed = this.config.allowedProjects ?? [];
    if (!allowed.includes(projectPath)) {
      this.updateAllowedProjects([...allowed, projectPath]);
    }
    console.log(`[AutonomousRunner] Project enabled: ${projectPath}`);
    this.persistSelection();
  }

  /** Get all currently enabled project paths */
  getEnabledProjects(): string[] {
    return Array.from(this.enabledProjects);
  }

  /**
   * Running pipeline tasks for the dashboard process view. With native in-process
   * adapters (codex-responses/openrouter/local) there is no child PID to show in
   * the OS process registry, so the dashboard reads these instead.
   */
  getRunningPipelines(): Array<{
    id: string; issue?: string; title: string; project: string;
    projectPath: string; startedAt: number; stage?: string;
  }> {
    return this.scheduler.getRunningTasks().map((r) => ({
      id: r.task.id,
      issue: r.task.issueIdentifier,
      title: r.task.title,
      project: r.task.linearProject?.name ?? r.projectPath.split('/').pop() ?? r.projectPath,
      projectPath: r.projectPath,
      startedAt: r.startedAt,
      stage: r.stage,
    }));
  }

  /** Cancel a running pipeline task by id (manual stop from the dashboard). */
  cancelTask(taskId: string): boolean {
    return this.scheduler.cancelTask(taskId);
  }

  /** Pre-register project path in cache (name → path) */
  registerProjectPath(name: string, projectPath: string): void {
    if (!this.projectPathCache.has(name)) {
      this.projectPathCache.set(name, projectPath);
    }
    // Also register capitalized variant to handle "openswarm" ↔ "Openswarm" mismatch
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    if (capitalized !== name && !this.projectPathCache.has(capitalized)) {
      this.projectPathCache.set(capitalized, projectPath);
    }
  }

  getProjectsInfo(): ProjectInfo[] {
    const running = this.scheduler.getRunningTasks();
    const queued = this.scheduler.getQueuedTasks();
    // Update path cache from currently running tasks
    for (const r of running) {
      if (r.task.linearProject?.name) this.projectPathCache.set(r.task.linearProject.name, r.projectPath);
    }
    return buildProjectsInfo(this.lastFetchedTasks, running, queued, this.projectPathCache, this.enabledProjects);
  }
}

export function getRunner(config?: AutonomousConfig): AutonomousRunner {
  if (!runnerInstance && config) {
    runnerInstance = new AutonomousRunner(config);
  }
  if (!runnerInstance) {
    throw new Error('Runner not initialized. Call getRunner with config first.');
  }
  return runnerInstance;
}

/**
 * Start runner (convenience function)
 */
export async function startAutonomous(config: AutonomousConfig): Promise<AutonomousRunner> {
  const runner = getRunner(config);
  await runner.start();
  return runner;
}

/**
 * Stop runner (convenience function)
 */
export function stopAutonomous(): void {
  if (runnerInstance) {
    runnerInstance.stop();
  }
}
