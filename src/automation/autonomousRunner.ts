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
  isRejectionLimitReached,
  canRetryNow,
  setRetryTime,
  clearRetryTime,
  formatRetryTime,
  getDailyPaceInfo,
  recordProjectCompletion,
  type TaskState,
  type ProjectInfo,
} from './runnerState.js';
import {
  DecisionEngine,
  DecisionResult,
  TaskItem,
  getDecisionEngine,
} from '../orchestration/decisionEngine.js';
// ExecutorResult used via execution.reportExecutionResult
import { checkWorkAllowed } from '../support/timeWindow.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { updateProjectAfterTask } from '../linear/projectUpdater.js';
import { TaskScheduler, initScheduler } from '../orchestration/taskScheduler.js';
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
import { pruneWorktrees } from '../support/worktreeManager.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { checkAllMonitors, getActiveMonitors } from './longRunningMonitor.js';
import { detectFileConflicts } from '../orchestration/conflictDetector.js';
import type { AutonomousConfig, RunnerState } from './runnerTypes.js';
import type { AdapterName } from '../adapters/types.js';

// Re-export types and integration setters (used by service.ts)
export { setNotifier, setTaskSource } from './runnerExecution.js';
export type { AutonomousConfig, RunnerState } from './runnerTypes.js';
export type { ProjectInfo } from './runnerState.js';

let runnerInstance: AutonomousRunner | null = null;

export class AutonomousRunner {
  private config: AutonomousConfig;
  private engine: DecisionEngine;
  private scheduler: TaskScheduler;
  private cronJob: Cron | null = null;
  private state: RunnerState = {
    isRunning: false,
    lastHeartbeat: 0,
    consecutiveErrors: 0,
  };

  // Heartbeat concurrency guard
  private _heartbeatRunning = false;

  // Explicitly enabled project paths (allow-list; empty = nothing runs)
  private enabledProjects = new Set<string>();

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

  // Last fetched Linear tasks (for dashboard display)
  private lastFetchedTasks: TaskItem[] = [];

  // Cache: linearProjectName → resolvedLocalPath (populated during task execution)
  private projectPathCache = new Map<string, string>();

  // Turbo mode: faster heartbeat, higher daily cap, no stage skipping
  private turboMode = false;
  private turboExpiresAt: number | null = null;
  private static readonly TURBO_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours auto-expire

  // Track completed/failed task IDs to prevent re-selection (persisted to disk)
  private completedTaskIds = new Set<string>();
  private failedTaskCounts = new Map<string, number>();
  private failedTaskRetryTimes = new Map<string, number>(); // issueId → next retry timestamp (ms)
  private static readonly MAX_RETRY_COUNT = 2; // Lowered from 4: a worker that can't
  // edit a complex task won't on retry 3-4 either (no-edit guard now fails empty edits
  // early). Block fast and rotate the backlog instead of one issue monopolizing it.

  private get taskStateRef(): TaskState {
    return {
      completedTaskIds: this.completedTaskIds,
      failedTaskCounts: this.failedTaskCounts,
      failedTaskRetryTimes: this.failedTaskRetryTimes,
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
    this.engine = getDecisionEngine({
      allowedProjects: config.allowedProjects,
      linearTeamId: config.linearTeamId,
      autoExecute: config.autoExecute,
      maxConsecutiveTasks: config.maxConsecutiveTasks,
      cooldownSeconds: config.cooldownSeconds,
      dryRun: config.dryRun,
    });

    // Initialize TaskScheduler
    this.scheduler = initScheduler({
      maxConcurrent: config.maxConcurrentTasks ?? 1,
      allowSameProjectConcurrent: false,
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

    this.scheduler.on('failed', async ({ task, result }) => {
      const taskCtx = this.formatTaskContext(task);
      console.log(`[Scheduler] Task failed: ${taskCtx} ${task.title}`);
      broadcastEvent({ type: 'task:completed', data: { taskId: task.id, success: false, duration: result.totalDuration } });
      this.recordPipelineHistory(task, result);
      await reportToDiscord(formatPipelineResultEmbed(result));

      // If rejected, track rejection count and block after max attempts
      if (task.issueId && result.finalStatus === 'rejected') {
        const feedback = result.reviewResult?.feedback || 'No feedback provided';
        const rejectionCount = incrementRejection(task.issueId, feedback);

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

          try {
            // Move to Backlog (non-recoverable) so the defer STICKS and the board reflects it —
            // symmetric with the failure-max path. Without this the issue stays "In Progress" on
            // Linear even though it's blocked: misleading on the board, and (before the Todo-only
            // recovery fix) it got re-selected every heartbeat.
            await getTaskSource()?.updateState(task.issueId, 'Backlog');
            await execution.syncFailureState(task, `Max rejection limit reached (${rejectionCount} attempts): ${feedback}`);
            await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
              `⚠️ **Max rejection limit reached (${rejectionCount} attempts)**\n\n` +
              `This task has been rejected ${rejectionCount} times by the reviewer and requires manual intervention.\n\n` +
              `**Latest rejection reason:**\n${feedback}\n\n` +
              `**Action required:** Please review the task requirements and code manually, or adjust the task scope.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} permanently blocked (max rejections reached)`);
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
        // Persist on EVERY increment. Previously saveTaskState ran only in the >=MAX block below,
        // so a count of 1 never hit disk — a frequently-restarted daemon reset mid-count and never
        // accumulated to the block threshold (looked like the same task looping forever).
        this.saveTaskState();

        if (count >= AutonomousRunner.MAX_RETRY_COUNT) {
          // Max retries exceeded - permanently block
          this.completedTaskIds.add(task.issueId); // Prevent re-selection
          clearRetryTime(task.issueId, this.failedTaskRetryTimes); // Clear retry time
          this.saveTaskState();
          console.log(`[Scheduler] Task failure count: ${count}/${AutonomousRunner.MAX_RETRY_COUNT} for ${taskCtx} — BLOCKED`);
          try {
            // Move the issue OUT of an active (recoverable) Linear state. syncFailureState only
            // updates the LOCAL store, so the issue stays "In Progress" on Linear — and
            // filterAlreadyProcessed treats any recoverable state + completedTaskIds as a manual
            // revert and "recovers" (re-selects) it every heartbeat, looping forever and starving
            // the backlog (and any dependents). Backlog is non-recoverable, so the block sticks;
            // a human moving it back to Todo/In Progress still re-enables retry via that path.
            await getTaskSource()?.updateState(task.issueId, 'Backlog');
            await execution.syncFailureState(task, `Autonomous execution failed ${count} times`);
            await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
              `Autonomous execution failed ${count} times. Moving to Blocked for manual review.`
            );
            console.log(`[Scheduler] Issue ${task.issueId} marked as Todo (blocked) (max retries exceeded)`);
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
    let backoffSkipped = 0;
    const filtered = tasks.filter(task => {
      const id = task.issueId || task.id;

      // Recover a blocked issue when a human (or the dashboard RESTART button) re-queued it by
      // moving it to Todo. This MUST run BEFORE the rejection-limit check, and its trigger MUST
      // include the rejection limit — otherwise a 3-rejection task stays blocked forever even after
      // being moved to Todo (the RESTART button only changes Linear state, never the OpenSwarm
      // rejection count, so the isRejectionLimitReached check below would skip it first).
      // Only 'Todo' counts (a human's deliberate retry); In Progress is syncFailureState's own
      // leftover state and must NOT be treated as a manual revert (that looped forever before).
      if (task.linearState === 'Todo' && (isRejectionLimitReached(id) || this.completedTaskIds.has(id) || (this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT)) {
        this.completedTaskIds.delete(id);
        this.failedTaskCounts.delete(id);
        clearRejection(id); // Clear rejection count on recovery
        clearRetryTime(id, this.failedTaskRetryTimes); // Clear retry backoff time
        recovered++;
        return true;
      }

      // Non-Todo tasks that hit the rejection limit stay blocked.
      if (isRejectionLimitReached(id)) {
        return false; // Skip tasks that hit max rejection limit
      }

      if (this.completedTaskIds.has(id)) return false;
      if ((this.failedTaskCounts.get(id) ?? 0) >= AutonomousRunner.MAX_RETRY_COUNT) return false;

      // Check if task is in exponential backoff period
      if (!canRetryNow(id, this.failedTaskRetryTimes)) {
        backoffSkipped++;
        return false; // Skip tasks still in backoff period
      }

      return true;
    });
    if (recovered > 0) {
      this.saveTaskState();
      this.syslog(`♻ Recovered ${recovered} Todo issues from completed/failed/rejected list`);
    }
    if (backoffSkipped > 0) {
      this.syslog(`⏰ Skipped ${backoffSkipped} tasks in exponential backoff period`);
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

    await this.scheduler.runAvailable(async (task, projectPath) => {
      return this.executePipeline(task, projectPath);
    });
  }

  private getRolesForProject(projectPath: string): DefaultRolesConfig | undefined {
    // Find per-project configuration
    const projectConfig = this.config.projectAgents?.find(
      pa => projectPath.includes(pa.projectPath.replace('~', ''))
    );

    // Base roles: defaultRoles (config) wins; else legacy autonomous.models
    // (workerModel/reviewerModel) if set; else undefined so each adapter uses its
    // OWN DEFAULT_MODEL. Never hardcode a model id here — a fixed id (gpt-* or
    // claude-*) breaks whichever adapter doesn't use that family (openrouter,
    // claude CLI, local, ...). A missing model flows through as undefined and
    // each adapter resolves `options.model ?? DEFAULT_MODEL`.
    let base = this.config.defaultRoles;
    if (!base && (this.config.workerModel || this.config.reviewerModel)) {
      base = {
        worker: { enabled: true, model: this.config.workerModel, timeoutMs: this.config.workerTimeoutMs ?? 0 },
        reviewer: { enabled: true, model: this.config.reviewerModel, timeoutMs: this.config.reviewerTimeoutMs ?? 0 },
      };
    }

    if (!base) {
      // No role config anywhere → adapter picks its own default model.
      if (!projectConfig?.roles) return undefined;
      return {
        worker: { enabled: true, ...projectConfig.roles.worker },
        reviewer: { enabled: true, ...projectConfig.roles.reviewer },
      } as DefaultRolesConfig;
    }

    if (!projectConfig?.roles) {
      return base;
    }

    // Merge per-project overrides onto the base.
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

      // 1.5 Quota gate (removed): the worker runs on codex (ChatGPT OAuth), so gating on
      // Anthropic Claude Max quota was meaningless — and it polled api.anthropic.com/oauth/usage
      // every heartbeat, which produced the 429 noise. Speed is governed by the cron schedule
      // and the Linear rate limiter, not by an Anthropic quota check.

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
      const tasks = fetchResult.tasks;
      if (tasks.length === 0) {
        this.syslog('— No tasks in backlog');
        return;
      }

      this.lastFetchedTasks = tasks;
      this.syslog(`✓ Found ${tasks.length} tasks from Linear`);

      // Filter out completed/over-retried tasks AND project-less tasks. A task with no
      // Linear project fails resolveProjectPath → SKIP; since the engine picks ONE task
      // per heartbeat, a perpetually-reselected project-less task starves the whole
      // backlog ("CI/CD 정기 유지보수 작업" stalled 68 issues this way).
      const filteredTasks = this.filterAlreadyProcessed(tasks)
        .filter((t) => t.linearProject?.id && t.linearProject?.name);
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

    // ALWAYS filter by resolvability (allowedProjects enforce + local dir present),
    // and fill projectPathCache as a side effect. This must NOT be gated on
    // enabledProjects.size > 0: enabledProjects is runtime state that resets on
    // restart, so gating let every task through after a restart and DecisionEngine
    // kept re-selecting unresolvable tasks (kis-agent/STO etc) → "mapping failed"
    // spam. allowedProjects (config) is the durable whitelist; enabledProjects only
    // narrows further when it happens to be set.
    const resolvedByProj = new Map<string, string | null>();
    const filtered: TaskItem[] = [];
    for (const task of executableTasks) {
      const projName = task.linearProject?.name;
      if (!projName) continue;
      if (!resolvedByProj.has(projName)) {
        resolvedByProj.set(projName, await this.resolveProjectPath(task));
      }
      const path = resolvedByProj.get(projName);
      if (!path) continue; // unresolvable (outside allowedProjects / no local dir)
      if (this.enabledProjects.size > 0 && !this.isProjectEnabled(path)) {
        this.syslog(`  ⚠ Project "${projName}" (${path}) not enabled — skipping ${task.issueIdentifier}`);
        continue;
      }
      filtered.push(task);
    }
    const tasksForEngine = filtered;
    if (tasksForEngine.length === 0) {
      this.syslog(`⚠ No resolvable tasks (${executableTasks.length} executable, ${tasks.length - executableTasks.length} backlog)`);
      this.syslog(`  allowedProjects: [${this.config.allowedProjects.join(', ')}]`);
      return;
    }
    this.syslog(`  Tasks: ${tasksForEngine.length} resolvable / ${executableTasks.length} executable / ${tasks.length} total`);

    // Get validated task list from DecisionEngine
    this.syslog('⟳ Decision Engine evaluating tasks...');
    const decision = await this.engine.heartbeatMultiple(
      tasksForEngine,
      maxSlots,
      [] // No project exclusion — worktree mode isolates each task
    );

    console.log(`[AutonomousRunner] Decision: ${decision.action} — ${decision.reason} (${decision.tasks?.length ?? 0} tasks)`);
    if (decision.action === 'skip' || decision.action === 'defer') {
      this.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      return;
    }

    // Add validated tasks to queue (with conflict detection)
    let enqueuedCount = 0;

    // Pre-filter: resolve project paths and skip invalid tasks
    const candidates: { task: TaskItem; projectPath: string }[] = [];
    for (const { task } of decision.tasks) {
      if (this.scheduler.isTaskQueued(task.id) || this.scheduler.isTaskRunning(task.id)) {
        this.syslog(`  Skip (already queued/running): ${task.issueIdentifier || task.id.slice(0, 8)} ${task.title}`);
        continue;
      }

      const projectPath = await this.resolveProjectPath(task);
      if (!projectPath) {
        this.syslog(`✗ Cannot resolve project path for "${task.linearProject?.name || task.title}" — skipping`);
        continue;
      }

      if (task.linearProject?.name) {
        this.projectPathCache.set(task.linearProject.name, projectPath);
      }

      if (this.scheduler.isProjectBusy(projectPath)) {
        this.syslog(`  Project busy: ${projectPath}`);
        continue;
      }

      if (this.enabledProjects.size > 0 && !this.isProjectEnabled(projectPath)) {
        this.syslog(`  Project not enabled: ${projectPath}`);
        continue;
      }

      // 프로젝트별 5시간 윈도우 cap (removed): the global pace gate (§1.6) was already removed by
      // user request; this remaining per-project 5h cap (dailyTaskCap, default 6) was the source of
      // "N/6 tasks in 5h window — throttled". Removed too — throughput is governed only by the cron
      // schedule and the Linear rate limiter, not by an internal completion cap.

      candidates.push({ task, projectPath });
    }

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

    // Enqueue safe tasks only
    for (const { task, projectPath } of candidates) {
      if (!safeTasks.has(task.id)) continue;

      this.scheduler.enqueue(task, projectPath);
      broadcastEvent({ type: 'task:queued', data: { taskId: task.id, title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
      this.syslog(`✓ Queued: ${task.issueIdentifier || ''} ${task.title} → ${projectPath.split('/').slice(-2).join('/')}`);
      enqueuedCount++;

      // Claim the task immediately: set Linear to 'In Progress' so restarts don't re-queue it
      if (task.issueId) {
        getTaskSource()?.updateState(task.issueId, 'In Progress').catch((err: Error) =>
          console.warn(`[AutonomousRunner] Failed to claim issue ${task.issueIdentifier}:`, err)
        );
      }
    }

    if (enqueuedCount === 0 && decision.skippedCount > 0) {
      this.syslog(`— No new tasks queued (skipped: ${decision.skippedCount})`);
    } else {
      this.syslog(`✓ Enqueued ${enqueuedCount} task(s) | skipped: ${decision.skippedCount}`);
    }

    // Execute tasks
    await this.runAvailableTasks();
  }

  /** Execute task in pair mode */
  private async executeTaskPairMode(task: TaskItem): Promise<void> {
    // Auto-resolve project path
    const projectPath = await this.resolveProjectPath(task);

    // Error if project path mapping failed
    if (!projectPath) {
      const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
      console.error(`[AutonomousRunner] ${errorMsg}`);
      await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
      return;
    }

    // Skip if project is not in enabled list (allow-list; empty = nothing runs)
    if (this.enabledProjects.size > 0 && !this.isProjectEnabled(projectPath)) {
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
        if (decomposed === true) {
          // Decomposition succeeded — sub-tasks queued, skip the original task.
          return;
        }
        // 'no-decomp' (planner judged it small) or false (failed): fall through and
        // execute the original task. The old `if (decomposed)` treated the
        // 'no-decomp' STRING as truthy and skipped the worker entirely, so every
        // task the planner declined to split silently never ran.
        console.log('[AutonomousRunner] No decomposition — executing original task');
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
              // INT-1613: persist the reviewer's follow-ups (recommendedActions + suggestions) as
              // a retrospective so the next worker sees what to revisit.
              reviewerLearnings: [
                ...(result.reviewResult?.recommendedActions?.map(
                  (a) => `[${a.type}] ${a.title}${a.file ? ` (${a.file})` : ''}`) ?? []),
                ...(result.reviewResult?.suggestions ?? []),
              ],
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
    };
  }

  private async resolveProjectPath(task: TaskItem): Promise<string | null> {
    return execution.resolveProjectPath(this.getExecCtx(), task);
  }

  private async decomposeTask(task: TaskItem, projectPath: string, targetMinutes: number): Promise<boolean | 'no-decomp'> {
    return execution.decomposeTask(this.getExecCtx(), task, projectPath, targetMinutes);
  }

  private async executePipeline(task: TaskItem, projectPath: string): Promise<PipelineResult> {
    return execution.executePipeline(this.getExecCtx(), task, projectPath);
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
  // Turbo Mode
  // ============================================

  getTurboMode(): boolean {
    // Auto-expire turbo
    if (this.turboMode && this.turboExpiresAt && Date.now() >= this.turboExpiresAt) {
      this.setTurboMode(false);
    }
    return this.turboMode;
  }

  setTurboMode(enabled: boolean): void {
    this.turboMode = enabled;
    if (enabled) {
      this.turboExpiresAt = Date.now() + AutonomousRunner.TURBO_DURATION_MS;
      const expiresIn = Math.round(AutonomousRunner.TURBO_DURATION_MS / 3_600_000);
      console.log(`[AutonomousRunner] TURBO MODE ON (auto-expires in ${expiresIn}h)`);
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: `TURBO ON — expires in ${expiresIn}h` } });
    } else {
      this.turboExpiresAt = null;
      console.log('[AutonomousRunner] TURBO MODE OFF');
      broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'turbo', line: 'TURBO OFF — normal pace resumed' } });
    }
  }

  getAdapterSummary() {
    const defaultAdapter = this.config.defaultAdapter ?? 'codex';
    const defaultRoles = this.config.defaultRoles;

    return {
      defaultAdapter,
      worker: {
        adapter: defaultRoles?.worker?.adapter ?? defaultAdapter,
        model: defaultRoles?.worker?.model ?? this.config.workerModel ?? '(adapter default)',
        enabled: defaultRoles?.worker?.enabled !== false,
      },
      reviewer: {
        adapter: defaultRoles?.reviewer?.adapter ?? defaultAdapter,
        model: defaultRoles?.reviewer?.model ?? this.config.reviewerModel ?? '(adapter default)',
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
    // Re-map each role's model to the target adapter. Keep a model only if it's
    // plausibly valid for that adapter; otherwise drop it to undefined so the
    // adapter uses its OWN DEFAULT_MODEL. Never translate to a hardcoded id of one
    // family (gpt-* / claude-*) — that breaks every other adapter (openrouter,
    // local, claude CLI, ...).
    const mapModelForProvider = (model: string | undefined, _role: 'worker' | 'reviewer' | 'tester' | 'documenter' | 'auditor' | 'skill-documenter'): string | undefined => {
      if (adapter === 'codex' || adapter === 'codex-responses') {
        // ChatGPT-account Codex only supports gpt-5.x / gpt-*-codex; anything else
        // (o-series, claude, openrouter ids) → undefined → adapter DEFAULT_MODEL.
        return model?.startsWith('gpt-') ? model : undefined;
      }
      if (adapter === 'claude') {
        // `claude -p` only accepts Claude models; an openrouter/codex id (qwen/…, gpt-…) is rejected
        // ("model may not exist") → undefined → claude's own default. INT-1487 hit this on switch.
        const isClaude = !!model && (model.startsWith('claude-') || ['sonnet', 'opus', 'haiku'].includes(model));
        return isClaude ? model : undefined;
      }
      // openrouter / gpt / local: trust the configured id as-is.
      return model;
    };

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

    // jobProfiles ALSO pin per-role models (config's light/heavy → qwen), and getModelForRole gives
    // the profile model precedence over defaultRoles. Remapping only defaultRoles left every
    // estimate-matched task on its old openrouter model → "I switched to Codex but it still uses
    // OpenRouter". Remap the profiles too: an incompatible id (qwen on codex) becomes undefined so
    // the adapter falls back to its OWN default model.
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
    this.enabledProjects.delete(projectPath);
    console.log(`[AutonomousRunner] Project disabled: ${projectPath}`);
  }

  enableProject(projectPath: string): void {
    this.enabledProjects.add(projectPath);
    console.log(`[AutonomousRunner] Project enabled: ${projectPath}`);
  }

  /** Get all currently enabled project paths */
  getEnabledProjects(): string[] {
    return Array.from(this.enabledProjects);
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
