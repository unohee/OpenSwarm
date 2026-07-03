// ============================================
// OpenSwarm - Pair Pipeline
// Worker → Reviewer → Tester → Documenter pipeline
// ============================================

import { EventEmitter } from 'node:events';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { WorkerResult, ReviewResult, PairSession } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { PipelineStage, RoleConfig, PipelineGuardsConfig, JobProfile } from '../core/types.js';
import { type CostInfo, aggregateCosts, formatCost } from '../support/costTracker.js';

import { broadcastEvent } from '../core/eventHub.js';
import { CONFIDENCE_THRESHOLDS } from './agentPair.js';
import * as agentPair from './agentPair.js';
import { runGuards, type GuardsRunResult } from './pipelineGuards.js';
import {
  type ReflectionState,
  type ReflectionSource,
  createReflectionState,
  recordReflection,
  shouldStopReflecting,
  buildReflectionFeedback,
  DEFAULT_MAX_REFLECTIONS,
} from './reflection.js';
import { hasRepoSnapshot, scanAndCache, analyzeIssue } from '../knowledge/index.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import { recallRepoKnowledge } from '../memory/repoKnowledge.js';
import type { WorkerContext } from '../locale/types.js';
import * as workerAgent from './worker.js';
import * as reviewerAgent from './reviewer.js';
import * as testerAgent from './tester.js';
import * as documenterAgent from './documenter.js';
import * as auditorAgent from './auditor.js';
import * as skillDocumenterAgent from './skillDocumenter.js';
import { StuckDetector, createStuckDetector } from '../support/stuckDetector.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import { resolveAdapterDefaultModel } from './stageModelResolver.js';
import { isClassifiedStageError, rethrowClassified, extractClassifiedStageResult, PipelineCancelledError } from './stageErrorClassification.js';

export { PipelineCancelledError };

// Types

export interface PipelineConfig {
  /** List of active stages (executed in order) */
  stages: PipelineStage[];
  /** Whether to continue on test failure */
  continueOnTestFail?: boolean;
  /** Skip Documenter if no changes */
  skipDocumenterIfNoChange?: boolean;
  /** Max total iterations (one cycle = Worker → Reviewer → Tester) */
  maxIterations?: number;
  /**
   * Max objective self-repair attempts (lint/bs/test failures) before the loop
   * gives up on bad edits. Independent of maxIterations so an operator can cap
   * token burn on reflection without shrinking the reviewer-revise budget.
   * Default: DEFAULT_MAX_REFLECTIONS (3).
   */
  maxReflections?: number;
  /** Per-role configuration */
  roles?: {
    worker?: RoleConfig;
    reviewer?: RoleConfig;
    tester?: RoleConfig;
    documenter?: RoleConfig;
    auditor?: RoleConfig;
    'skill-documenter'?: RoleConfig;
  };
  /** Pipeline guards configuration */
  guards?: Partial<PipelineGuardsConfig>;
  /** Optional job profiles for model selection */
  jobProfiles?: JobProfile[];
  /** Runtime metadata used by observers such as the TUI pipeline tree. */
  runMetadata?: PipelineRunMetadata;
  /** Skip tester if no code files (.ts/.js/.py etc.) changed (default: true) */
  skipTesterIfNoCodeChange?: boolean;
  /** Skip auditor if fewer than N files changed (default: 3) */
  skipAuditorUnderFileCount?: number;
  /** Enable verbose logging (detailed stage info, agent decisions, timing) */
  verbose?: boolean;
  /** Draft Analyzer 사전 분석 결과 (Haiku) — Worker/Planner에 주입 */
  draftAnalysis?: {
    taskType: string;
    intentSummary: string;
    relevantFiles: string[];
    suggestedApproach: string;
    projectStats?: string;
    completionCriteria?: string[];
    sufficient?: boolean;
    impactAnalysis?: import('../knowledge/types.js').ImpactAnalysis;
    registrySnapshot?: Array<{ filePath: string; summary: string; highlights: string[] }>;
  };
}

export interface PipelineRunMetadata {
  repository?: string;
  projectPath?: string;
  worktree?: string;
  branch?: string;
  issueIdentifier?: string;
  title?: string;
}

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult | { success: false; error: string };
  duration: number;
  /** Stage start time (epoch ms) */
  startedAt: number;
  /** Stage completion time (epoch ms) */
  completedAt: number;
}

export interface PipelineResult {
  success: boolean;
  sessionId: string;
  stages: StageResult[];
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed' | 'rate_limited' | 'infra_error';
  /** Unix timestamp (ms) when the rate-limit quota resets — set when finalStatus is 'rate_limited'. */
  rateLimitResetsAt?: number;
  totalDuration: number;
  /** Total number of completed iterations */
  iterations: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  /** Task context (for reporting) */
  taskContext?: {
    issueIdentifier?: string;
    projectName?: string;
    projectPath?: string;
    taskTitle?: string;
  };
  /** PR URL (auto-created PR in worktree mode) */
  prUrl?: string;
  /** Total cost across all stages */
  totalCost?: CostInfo;
}

export interface PipelineContext {
  task: TaskItem;
  projectPath: string;
  session: PairSession;
  config: PipelineConfig;
  /** Current iteration number (1-based) */
  currentIteration: number;
  /** Formatted task prefix for consistent logging (e.g., "OpenSwarm | INT-1171 | worktree/abc123") */
  taskPrefix: string;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  guardsResult?: GuardsRunResult;
  /** Accumulated objective (lint/bs/test) errors for self-repair reflection */
  reflection: ReflectionState;
  /**
   * Source of the latest revise feedback. 'objective' failures (lint/bs/test)
   * flow through the reflection trail and are preserved across fresh-context
   * resets; 'review' feedback (reviewer/halt) is subjective and dropped on a
   * fresh-context retry.
   */
  feedbackSource?: 'objective' | 'review';
}

/**
 * Build a consistent task prefix for logging across all pipeline stages.
 * Format: "ProjectName | INT-XXX | worktree/abc123" or "ProjectName | INT-XXX"
 */
export function buildTaskPrefix(task: TaskItem, projectPath: string): string {
  const parts: string[] = [];
  const projectName = task.linearProject?.name || projectPath.split('/').pop() || 'unknown';
  parts.push(projectName);
  if (task.issueIdentifier) {
    parts.push(task.issueIdentifier);
  } else if (task.issueId) {
    parts.push(task.issueId.slice(0, 8));
  }
  // Detect worktree path
  const worktreeMatch = projectPath.match(/worktree\/([a-f0-9-]+)/);
  if (worktreeMatch) {
    parts.push(`worktree/${worktreeMatch[1].slice(0, 8)}`);
  }
  return parts.join(' | ');
}

// Pipeline Events

export type PipelineEventType =
  | 'stage:start'
  | 'stage:complete'
  | 'stage:fail'
  | 'iteration:start'
  | 'iteration:complete'
  | 'iteration:fail'
  | 'pipeline:complete'
  | 'pipeline:fail'
  | 'halt';

// Pair Pipeline

export class PairPipeline extends EventEmitter {
  private config: PipelineConfig;
  private stuckDetector: StuckDetector;
  private jobProfiles: JobProfile[];
  /** Set per run() — aborts the pipeline + in-flight adapter call on cancel/disable. */
  private abortSignal?: AbortSignal;
  /** Cache of adapter default models (heavy: OAuth + live catalog) keyed by adapter name. (INT-2393) */
  private defaultModelCache = new Map<string, Promise<string | undefined>>();

  /** Throw if this run has been cancelled. Called at iteration/stage boundaries. */
  private throwIfAborted(): void {
    if (this.abortSignal?.aborted) throw new PipelineCancelledError();
  }

  constructor(config: PipelineConfig) {
    super();
    this.config = {
      continueOnTestFail: false,
      skipDocumenterIfNoChange: true,
      maxIterations: 3,
      maxReflections: DEFAULT_MAX_REFLECTIONS,
      ...config,
    };
    // Initialize stuck detector
    this.stuckDetector = createStuckDetector({
      sameErrorRepeat: 2,
      revisionLoop: 4,
    });
    this.jobProfiles = config.jobProfiles ?? [];
  }

  private matchesProfile(task: TaskItem, profile: JobProfile): boolean {
    const estimate = task.estimatedMinutes ?? 0;
    if (profile.minMinutes != null && estimate < profile.minMinutes) return false;
    if (profile.maxMinutes != null && estimate > profile.maxMinutes) return false;
    if (profile.priority != null && task.priority !== profile.priority) return false;
    return true;
  }

  private getProfileForTask(task: TaskItem): JobProfile | undefined {
    if (!this.jobProfiles || this.jobProfiles.length === 0) return undefined;
    return this.jobProfiles.find((profile) => this.matchesProfile(task, profile));
  }

  private getModelForRole(stage: PipelineStage, task: TaskItem): string | undefined {
    const profile = this.getProfileForTask(task);
    return profile?.roles?.[stage] || this.config.roles?.[stage]?.model;
  }


  /** Reasoning effort from the matched jobProfile (heavy tasks reason harder). */
  private getEffortForTask(task: TaskItem): 'low' | 'medium' | 'high' | undefined {
    return this.getProfileForTask(task)?.effort;
  }

  // ============================================
  // Main Execution
  // ============================================

  /**
   * Run pipeline
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure at any stage, returns to Worker (up to maxIterations)
   */
  async run(task: TaskItem, projectPath: string, opts?: { signal?: AbortSignal }): Promise<PipelineResult> {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const maxIterations = this.config.maxIterations ?? 3;
    this.abortSignal = opts?.signal;

    // Reset stuck detector (new pipeline run)
    this.stuckDetector.reset();

    // Ensure repo graph snapshot exists (first-time scan if needed)
    if (!hasRepoSnapshot(projectPath)) {
      console.log(`[Pipeline] No repo snapshot found, scanning ${projectPath}...`);
      try {
        await scanAndCache(projectPath);
      } catch (e) {
        console.warn(`[Pipeline] Repo scan failed (non-blocking):`, e);
      }
    }

    // Create session
    const session = agentPair.createPairSession({
      taskId: task.issueIdentifier || task.issueId || task.id,
      taskTitle: task.title,
      taskDescription: task.description || '',
      projectPath,
      maxAttempts: maxIterations,
      models: {
        worker: this.config.roles?.worker?.model,
        reviewer: this.config.roles?.reviewer?.model,
      },
    });

    const taskPrefix = buildTaskPrefix(task, projectPath);

    const context: PipelineContext = {
      task,
      projectPath,
      session,
      config: this.config,
      currentIteration: 0,
      taskPrefix,
      reflection: createReflectionState(),
    };

    try {
      // Full iteration loop: Worker → Reviewer → Tester
      const iterationResult = await this.runFullIterationLoop(context, stages);

      if (!iterationResult.success) {
        return this.buildResult(context, stages, startTime);
      }

      // Run Documenter after all stages pass
      if (this.hasStage('documenter') && context.workerResult?.success) {
        if (
          this.config.skipDocumenterIfNoChange &&
          (!context.workerResult.filesChanged || context.workerResult.filesChanged.length === 0)
        ) {
          console.log(`[${context.taskPrefix}] Skipping documenter: no files changed`);
        } else {
          const documenterResult = await this.runStage('documenter', context);
          stages.push(documenterResult);
          // Documenter failure does not cause overall failure
        }
      }

      // Auditor (post-success, non-blocking)
      if (this.hasStage('auditor') && context.workerResult?.success) {
        const auditorFileThreshold = this.config.skipAuditorUnderFileCount ?? 3;
        const auditorChangedFiles = context.workerResult.filesChanged || [];
        if (auditorChangedFiles.length < auditorFileThreshold) {
          console.log(`[${context.taskPrefix}] Skipping auditor: ${auditorChangedFiles.length} files changed (threshold: ${auditorFileThreshold})`);
        } else {
          const auditorResult = await this.runStage('auditor', context);
          stages.push(auditorResult);
          // Auditor failure does not affect overall success
        }
      }

      // Skill Documenter (post-success, non-blocking)
      if (this.hasStage('skill-documenter') && context.workerResult?.success) {
        const sdResult = await this.runStage('skill-documenter', context);
        stages.push(sdResult);
        // Skill Documenter failure does not affect overall success
      }

      // Success
      agentPair.updateSessionStatus(session.id, 'approved');
      return this.buildResult(context, stages, startTime);

    } catch (error) {
      // Cancellation (project disable / manual stop) is not a failure — surface it
      // as 'cancelled' so the scheduler doesn't count it failed or trigger a retry.
      const cancelled = error instanceof PipelineCancelledError || !!this.abortSignal?.aborted;
      // A 429/usage-limit propagates up here from any stage (worker/reviewer/…).
      // Surface it as its own finalStatus so the runner pauses until quota resets
      // instead of counting a failure and spamming Linear comments. (INT-1906)
      const rateLimited = !cancelled && error instanceof RateLimitError;
      // An infra/CLI failure (worker/reviewer never ran: non-zero exit, auth,
      // spawn, timeout) is not a task failure — surface it distinctly so the
      // runner does a backoff retry instead of counting it toward STUCK. (INT-2010)
      const infra = !cancelled && !rateLimited && isInfraError(error);
      const classifiedStage = extractClassifiedStageResult(error); // INT-2424
      if (classifiedStage) stages.push(classifiedStage);
      if (cancelled) {
        console.log(`[${context.taskPrefix}] Pipeline cancelled`);
      } else if (rateLimited) {
        console.warn(`[${context.taskPrefix}] Pipeline rate-limited: ${(error as RateLimitError).message}`);
      } else if (infra) {
        console.warn(`[${context.taskPrefix}] Pipeline infra error (not counted toward STUCK): ${error instanceof Error ? error.message : String(error)}`);
      } else {
        console.error('[%s] Error:', context.taskPrefix, error);
      }
      agentPair.updateSessionStatus(session.id, 'failed');
      return {
        success: false,
        sessionId: session.id,
        stages,
        finalStatus: cancelled ? 'cancelled' : rateLimited ? 'rate_limited' : infra ? 'infra_error' : 'failed',
        rateLimitResetsAt: rateLimited && (error as RateLimitError).resetsAt
          ? (error as RateLimitError).resetsAt! * 1000
          : undefined,
        totalDuration: Date.now() - startTime,
        iterations: context.currentIteration,
        workerResult: context.workerResult,
        reviewResult: context.reviewResult,
        testerResult: context.testerResult,
        documenterResult: context.documenterResult,
        taskContext: {
          issueIdentifier: context.task.issueIdentifier || context.task.issueId,
          projectName: context.task.linearProject?.name,
          projectPath: context.projectPath,
          taskTitle: context.task.title,
        },
      };
    }
  }

  // ============================================
  // Stage Execution
  // ============================================

  /**
   * Worker에 주입할 코드 컨텍스트 수집
   * Draft 분석이 있으면 재사용, 없으면 직접 수집
   */
  private async collectWorkerContext(context: PipelineContext): Promise<WorkerContext | undefined> {
    try {
      const wc: WorkerContext = {};
      const draft = this.config.draftAnalysis;

      // Draft 분석 결과가 있으면 우선 사용 (중복 API 호출 방지)
      if (draft) {
        wc.draftAnalysis = {
          taskType: draft.taskType,
          intentSummary: draft.intentSummary,
          relevantFiles: draft.relevantFiles,
          suggestedApproach: draft.suggestedApproach,
          projectStats: draft.projectStats,
          completionCriteria: draft.completionCriteria,
          sufficient: draft.sufficient,
        };

        if (draft.impactAnalysis) {
          wc.impactAnalysis = draft.impactAnalysis;
        }
        if (draft.registrySnapshot && draft.registrySnapshot.length > 0) {
          wc.registryBriefs = draft.registrySnapshot;
        }
      }

      // Draft에 impactAnalysis가 없으면 직접 수집
      if (!wc.impactAnalysis) {
        const impact = await analyzeIssue(
          context.projectPath,
          context.task.title,
          context.task.description || '',
        );
        if (impact && (impact.directModules.length > 0 || impact.dependentModules.length > 0)) {
          wc.impactAnalysis = impact;
        }
      }

      // Draft에 registryBriefs가 없으면 직접 수집
      if (!wc.registryBriefs) {
        const affectedFiles = new Set<string>();
        if (wc.impactAnalysis) {
          for (const mod of wc.impactAnalysis.directModules) affectedFiles.add(mod);
          for (const mod of wc.impactAnalysis.dependentModules.slice(0, 5)) affectedFiles.add(mod);
        }

        if (affectedFiles.size > 0) {
          try {
            const store = getRegistryStore();
            const briefs: WorkerContext['registryBriefs'] = [];

            for (const filePath of affectedFiles) {
              const brief = store.fileBrief(filePath);
              if (brief.entities.length === 0) continue;

              const highlights: string[] = [];
              for (const e of brief.entities) {
                if (e.status === 'deprecated') highlights.push(`${e.name} (deprecated)`);
                else if (e.status === 'broken') highlights.push(`${e.name} (broken)`);
                const critical = e.warnings.filter(w => !w.resolved && w.severity === 'critical');
                if (critical.length > 0) highlights.push(`${e.name} (${critical.length} critical)`);
              }

              // entity 목록 — Worker가 파일을 읽지 않고 구조 파악 (상위 15개)
              const entities = brief.entities.slice(0, 15).map(e => ({
                kind: e.kind,
                name: e.name,
                signature: e.signature?.slice(0, 80),
                status: e.status,
                hasTests: e.hasTests,
              }));

              briefs.push({ filePath: brief.filePath, summary: brief.summary, highlights, entities });
            }

            if (briefs.length > 0) {
              wc.registryBriefs = briefs;
            }
          } catch {
            // Registry 미초기화
          }
        }
      }

      // Recall repo knowledge accumulated from past tasks — the core loop that
      // makes the worker understand this repo better over time (non-blocking on failure)
      const memories = await recallRepoKnowledge(
        context.projectPath,
        context.task.title,
        context.task.description || '',
      );
      if (memories.length > 0) {
        wc.repoMemories = memories;
        console.log(`[Pipeline] Recalled ${memories.length} repo memories for context`);
      }

      if (!wc.impactAnalysis && !wc.registryBriefs && !wc.draftAnalysis && !wc.repoMemories) return undefined;
      return wc;
    } catch (err) {
      console.warn('[Pipeline] Worker context collection failed (non-blocking):', err);
      return undefined;
    }
  }

  /**
   * Check if a stage is enabled
   */
  private hasStage(stage: PipelineStage): boolean {
    return this.config.stages.includes(stage);
  }

  /**
   * Run a single stage
   */
  private async runStage(
    stage: PipelineStage,
    context: PipelineContext,
    overrides?: { model?: string }
  ): Promise<StageResult> {
    const startTime = Date.now();
    // Display model: explicit override → configured (jobProfile/role) → adapter
    // default (so the TUI/dashboard aren't blank when config omits it). (INT-2393)
    const stageModel = overrides?.model
      ?? this.getModelForRole(stage, context.task)
      ?? await resolveAdapterDefaultModel(this.config.roles?.[stage]?.adapter, this.defaultModelCache);
    const prefix = context.taskPrefix;
    const metadata = this.stageMetadata(context);
    console.log(`[${prefix}] Stage starting: ${stage}`);
    this.emit('stage:start', { stage, context, model: stageModel });
    broadcastEvent({ type: 'pipeline:stage', data: { taskId: context.task.id, stage, status: 'start', model: stageModel, ...metadata } });

    if (this.config.verbose) {
      this.emit('log', { line: `[verbose] Stage: ${stage} | model: ${stageModel ?? 'default'} | iteration: ${context.currentIteration}` });
    }

    try {
      let result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult;

      switch (stage) {
        case 'worker': {
          agentPair.updateSessionStatus(context.session.id, 'working');
          const taskId = context.task.id;
          const onLog = (line: string) =>
            broadcastEvent({ type: 'log', data: { taskId, stage: 'worker', line: `[${prefix}] ${line}` } });

          // Check if fresh context should be used (after N failures)
          const useFreshContext = agentPair.shouldUseFreshContext(context.session.id);
          if (useFreshContext) {
            console.log(`[${prefix}] Using fresh context for worker (retry with clean slate)`);
            agentPair.consumeFreshContext(context.session.id);
            onLog('🔄 Using fresh context (previous attempts failed)');
          }

          // 코드 컨텍스트 수집 (첫 시도 정확도 향상 목적)
          const workerContext = await this.collectWorkerContext(context);
          if (workerContext && this.config.verbose) {
            const modCount = (workerContext.impactAnalysis?.directModules.length ?? 0)
              + (workerContext.impactAnalysis?.dependentModules.length ?? 0);
            const briefCount = workerContext.registryBriefs?.length ?? 0;
            this.emit('log', { line: `[verbose] Worker context: ${modCount} affected modules, ${briefCount} file briefs` });
          }

          // Self-repair feedback: objective lint/test errors (reflection trail)
          // are always carried forward — ground truth that survives a fresh-context
          // reset. The reviewer's revision prompt is ALSO preserved across fresh
          // context (INT-1705): it carries the task requirement (e.g. "wire it into
          // the heartbeat / add the call site"), not chat pollution — dropping it
          // made the worker repeat the same partial impl forever. Fresh context
          // still clears the worker's own chat history; only the reviewer's task
          // signal is kept.
          const reflectionPart = buildReflectionFeedback(context.reflection);
          const includeReview =
            context.feedbackSource === 'review' && !!context.reviewResult;
          const reviewPart = includeReview
            ? reviewerAgent.buildRevisionPrompt(context.reviewResult!)
            : undefined;
          const combinedFeedback =
            [reflectionPart, reviewPart].filter(Boolean).join('\n\n') || undefined;

          result = await workerAgent.runWorker({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            projectPath: context.projectPath,
            previousFeedback: combinedFeedback,
            timeoutMs: this.config.roles?.worker?.timeoutMs ?? 0,
            // getModelForRole gives the matched jobProfile's model precedence (config's
            // light/heavy → gpt-5.5/5.4), falling back to roles.worker.model. Reading
            // roles.worker.model directly here silently dropped the jobProfile model, so a
            // codex worker fell through to the CLI's config.toml default (Codex-Spark). (INT-1599)
            model: overrides?.model ?? this.getModelForRole('worker', context.task),
            maxTurns: this.config.roles?.worker?.maxTurns,
            adapterName: this.config.roles?.worker?.adapter,
            reasoningEffort: this.getEffortForTask(context.task),
            bashTimeoutMs: await workerAgent.resolveWorkerBashTimeout(context.projectPath, this.getEffortForTask(context.task)), // INT-2415
            // No-edit guard (re-applied from stranded feat/v0.7.0 commit 2eea3bc):
            // reasoning workers frequently end with analysis only and never call
            // edit_file. Without this the guard defaults to 0 (disabled) — measured:
            // codex spark AND gpt-5.5 both read 30-37× and shipped 0 edits. Push the
            // worker to actually edit before concluding.
            nudgeMaxOnNoEdit: 3,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: context.task.id, stage: 'worker' },
            workerContext,
            signal: this.abortSignal,
          });
          agentPair.saveWorkerResult(context.session.id, result as WorkerResult);
          context.workerResult = result as WorkerResult;

          // Verbose: emit detailed worker result info
          if (this.config.verbose) {
            const wr = result as WorkerResult;
            if (wr.filesChanged?.length) {
              this.emit('log', { line: `[verbose] Files changed: ${wr.filesChanged.join(', ')}` });
            }
            if (wr.commands?.length) {
              this.emit('log', { line: `[verbose] Commands executed: ${wr.commands.join('; ')}` });
            }
            if (wr.confidencePercent != null) {
              this.emit('log', { line: `[verbose] Worker confidence: ${wr.confidencePercent}%` });
            }
            if (wr.haltReason) {
              this.emit('log', { line: `[verbose] Worker halt reason: ${wr.haltReason}` });
            }
          }

          // Track confidence and check for degradation
          const attempt = context.session.worker.attempts;
          agentPair.updateConfidenceTracker(context.session.id, result as WorkerResult, attempt);

          // Check if confidence intervention is needed
          if (agentPair.needsConfidenceIntervention(context.session.id)) {
            console.warn(`[${prefix}] Confidence intervention needed - early review triggered`);
            const summary = agentPair.getConfidenceSummary(context.session.id);
            this.emit('log', { line: `⚠️ Low confidence detected: ${summary}` });
            // Continue to review, but reviewer should be aware of low confidence
          }

          break;
        }

        case 'reviewer':
          agentPair.updateSessionStatus(context.session.id, 'reviewing');
          if (!context.workerResult) {
            throw new Error('Worker result required for reviewer');
          }

          // Pre-check disabled - Haiku format compliance issues causing false rejections
          // Proceed directly to full review for reliability.
          // NOTE: the old "high worker confidence → fewer reviewer turns" shortcut was
          // removed (INT-1914): worker confidence is self-reported, so a confidently
          // scaffolded task was getting LESS review — exactly the wrong incentive. The
          // completion-criteria hard gate is the real check now.
          const reviewerMaxTurns = this.config.roles?.reviewer?.maxTurns;
          const reviewerOptions = {
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.reviewer?.timeoutMs ?? 0,
            // jobProfile model precedence (see worker stage above). (INT-1599)
            model: this.getModelForRole('reviewer', context.task),
            maxTurns: reviewerMaxTurns,
            adapterName: this.config.roles?.reviewer?.adapter,
            reasoningEffort: this.getEffortForTask(context.task),
            completionCriteria: this.config.draftAnalysis?.completionCriteria,
            // Surface non-blocking guard warnings (dead-module, reformat/scope)
            // so the reviewer verifies them instead of them dying in a log. (INT-2388)
            guardWarnings: context.guardsResult?.results
              .filter(r => !r.passed && !r.blocking)
              .flatMap(r => r.issues),
            processContext: { taskId: context.task.id, stage: 'reviewer' },
            signal: this.abortSignal,
          };

          console.log(`[${prefix}] Running full review...`);
          result = await reviewerAgent.runReviewer(reviewerOptions);

          agentPair.saveReviewerResult(context.session.id, result as ReviewResult);
          context.reviewResult = result as ReviewResult;

          // Verbose: emit reviewer decision details
          if (this.config.verbose) {
            const rr = result as ReviewResult;
            this.emit('log', { line: `[verbose] Reviewer decision: ${rr.decision}` });
            if (rr.feedback) {
              const lines = rr.feedback.split('\n').slice(0, 10);
              for (const line of lines) {
                this.emit('log', { line: `[verbose]   ${line}` });
              }
            }
          }
          break;

        case 'tester':
          if (!context.workerResult) {
            throw new Error('Worker result required for tester');
          }
          result = await testerAgent.runTester({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.tester?.timeoutMs ?? 0,
            model: this.config.roles?.tester?.model,
            maxTurns: this.config.roles?.tester?.maxTurns,
            adapterName: this.config.roles?.tester?.adapter,
          });
          context.testerResult = result as TesterResult;

          // Verbose: emit tester details
          if (this.config.verbose) {
            const tr = result as TesterResult;
            this.emit('log', { line: `[verbose] Tests passed: ${tr.testsPassed}, failed: ${tr.testsFailed}${tr.coverage != null ? `, coverage: ${tr.coverage}%` : ''}` });
          }
          break;

        case 'documenter':
          if (!context.workerResult) {
            throw new Error('Worker result required for documenter');
          }
          result = await documenterAgent.runDocumenter({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.documenter?.timeoutMs ?? 0,
            model: this.config.roles?.documenter?.model,
            maxTurns: this.config.roles?.documenter?.maxTurns,
            adapterName: this.config.roles?.documenter?.adapter,
          });
          context.documenterResult = result as DocumenterResult;
          break;

        case 'auditor':
          if (!context.workerResult) {
            throw new Error('Worker result required for auditor');
          }
          result = await auditorAgent.runAuditor({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.auditor?.timeoutMs ?? 0,
            model: this.config.roles?.auditor?.model,
            maxTurns: this.config.roles?.auditor?.maxTurns,
            adapterName: this.config.roles?.auditor?.adapter,
          });
          context.auditorResult = result as AuditorResult;
          break;

        case 'skill-documenter':
          if (!context.workerResult) {
            throw new Error('Worker result required for skill-documenter');
          }
          result = await skillDocumenterAgent.runSkillDocumenter({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.['skill-documenter']?.timeoutMs ?? 0,
            model: this.config.roles?.['skill-documenter']?.model,
            maxTurns: this.config.roles?.['skill-documenter']?.maxTurns,
            adapterName: this.config.roles?.['skill-documenter']?.adapter,
          });
          context.skillDocumenterResult = result as SkillDocumenterResult;
          break;

        default:
          throw new Error(`Unknown stage: ${stage}`);
      }

      const completedAt = Date.now();
      const stageResult: StageResult = {
        stage,
        success: this.isStageSuccess(stage, result),
        result,
        duration: completedAt - startTime,
        startedAt: startTime,
        completedAt,
      };

      console.log(`[${prefix}] ${stage} completed (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:complete', { stage, result: stageResult, context });
      const costInfo = (result as { costInfo?: CostInfo }).costInfo;

      if (this.config.verbose) {
        this.emit('log', { line: `[verbose] Stage ${stage} completed in ${(stageResult.duration / 1000).toFixed(1)}s${costInfo ? ` | cost: $${costInfo.costUsd.toFixed(4)} (${costInfo.inputTokens}in/${costInfo.outputTokens}out)` : ''}` });
      }
      broadcastEvent({ type: 'pipeline:stage', data: {
        taskId: context.task.id, stage, status: 'complete',
        ...metadata,
        model: costInfo?.model ?? stageModel,
        inputTokens: costInfo?.inputTokens,
        outputTokens: costInfo?.outputTokens,
        costUsd: costInfo?.costUsd,
        durationMs: stageResult.duration,
        ...summarizeStageResult(stage, result),
      } });
      return stageResult;

    } catch (error) {
      const completedAt = Date.now();
      const stageResult: StageResult = {
        stage,
        success: false,
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        duration: completedAt - startTime,
        startedAt: startTime,
        completedAt,
      };

      console.log(`[${prefix}] ${stage} failed (${(stageResult.duration / 1000).toFixed(1)}s)`);
      this.emit('stage:fail', { stage, result: stageResult, context, error });
      broadcastEvent({ type: 'pipeline:stage', data: {
        taskId: context.task.id, stage, status: 'fail',
        ...metadata,
        model: stageModel,
        durationMs: stageResult.duration,
        rateLimitResetsAt: error instanceof RateLimitError && error.resetsAt ? error.resetsAt * 1000 : undefined,
        error: error instanceof Error ? error.message : String(error),
      } });
      if (isClassifiedStageError(error)) rethrowClassified(error, stageResult); // INT-2424
      return stageResult;
    }
  }

  private stageMetadata(context: PipelineContext): PipelineRunMetadata {
    const configured = this.config.runMetadata ?? {};
    const projectPath = configured.projectPath ?? context.projectPath;
    return {
      repository: configured.repository ?? context.task.linearProject?.name ?? repoNameFromPath(projectPath),
      projectPath,
      worktree: configured.worktree ?? worktreeNameFromPath(projectPath),
      branch: configured.branch,
      issueIdentifier: configured.issueIdentifier ?? context.task.issueIdentifier ?? context.task.issueId,
      title: configured.title ?? context.task.title,
    };
  }

  /**
   * Determine stage success
   */
  private isStageSuccess(
    stage: PipelineStage,
    result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult
  ): boolean {
    switch (stage) {
      case 'worker':
        return (result as WorkerResult).success;

      case 'reviewer':
        return (result as ReviewResult).decision === 'approve';

      case 'tester':
        return (result as TesterResult).success;

      case 'documenter':
        return (result as DocumenterResult).success;

      case 'auditor':
        return (result as AuditorResult).success;

      case 'skill-documenter':
        return (result as SkillDocumenterResult).success;

      default:
        return false;
    }
  }

  /**
   * Decide whether to stop the bounded self-repair loop after an objective
   * (lint/bs/test) failure. Aborts when the agent is stagnating (identical
   * errors twice in a row) or has spent its reflection budget — either way
   * further retries only burn tokens (the regression guard from the task spec).
   * Returns true when the caller should terminate the pipeline as failed.
   */
  private shouldAbortSelfRepair(
    context: PipelineContext,
    progressed: boolean,
    source: ReflectionSource,
  ): boolean {
    const max = this.config.maxReflections ?? DEFAULT_MAX_REFLECTIONS;
    const budgetSpent = shouldStopReflecting(context.reflection, max);
    if (progressed && !budgetSpent) return false;

    const reason = !progressed
      ? `self-repair stagnated: identical ${source} errors repeated`
      : `self-repair budget exhausted (${context.reflection.reflectionCount}/${max} objective failures)`;
    console.warn(`[${context.taskPrefix}] Aborting self-repair — ${reason}`);
    this.emit('log', { line: `🛑 ${reason}` });
    this.emit('reflection:abort', {
      reason,
      source,
      reflectionCount: context.reflection.reflectionCount,
      context,
    });
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return true;
  }

  // ============================================
  // Full Iteration Loop
  // ============================================

  /**
   * Full iteration loop
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure (revise) at any stage, restart from Worker in next iteration
   * reject = immediate termination
   */
  private async runFullIterationLoop(
    context: PipelineContext,
    stages: StageResult[]
  ): Promise<{ success: boolean }> {
    const maxIterations = this.config.maxIterations ?? 3;
    const hasWorker = this.hasStage('worker');
    const hasReviewer = this.hasStage('reviewer');
    const hasTester = this.hasStage('tester');

    // No point without a worker
    if (!hasWorker) {
      console.log(`[${context.taskPrefix}] No worker stage configured`);
      return { success: false };
    }

    while (context.currentIteration < maxIterations) {
      this.throwIfAborted(); // bail before starting another iteration
      context.currentIteration++;

      // Stuck detection check (before iteration starts)
      const stuckCheck = this.stuckDetector.check();
      if (stuckCheck.isStuck) {
        console.error(`[${context.taskPrefix}] STUCK DETECTED: ${stuckCheck.reason}`);
        console.error(`[${context.taskPrefix}] Suggestion: ${stuckCheck.suggestion}`);
        this.emit('stuck', {
          reason: stuckCheck.reason,
          suggestion: stuckCheck.suggestion,
          context,
        });
        agentPair.updateSessionStatus(context.session.id, 'failed');
        return { success: false };
      }

      this.emit('iteration:start', {
        iteration: context.currentIteration,
        maxIterations,
        context,
      });
      broadcastEvent({ type: 'pipeline:iteration', data: { taskId: context.task.id, iteration: context.currentIteration } });

      console.log(`[${context.taskPrefix}] Iteration ${context.currentIteration}/${maxIterations}`);

      // ========== WORKER (with escalation) ==========
      const workerCfg = this.config.roles?.worker;
      const escalateThreshold = workerCfg?.escalateAfterIteration ?? 2;
      const escalateModel = workerCfg?.escalateModel;
      const shouldEscalate = context.currentIteration >= escalateThreshold && !!escalateModel;
      const baseWorkerModel = this.getModelForRole('worker', context.task);
      const workerOverrides = shouldEscalate
        ? { model: escalateModel }
        : (baseWorkerModel ? { model: baseWorkerModel } : undefined);

      if (shouldEscalate && escalateModel) {
        console.log(`[${context.taskPrefix}] Escalating worker model → ${escalateModel} (iteration ${context.currentIteration})`);
        broadcastEvent({ type: 'pipeline:escalation', data: {
          taskId: context.task.id,
          iteration: context.currentIteration,
          fromModel: workerCfg?.model,
          toModel: escalateModel,
        } });
      }

      agentPair.updateSessionStatus(context.session.id, 'working');
      const workerResult = await this.runStage('worker', context, workerOverrides);
      stages.push(workerResult);

      // Record Worker result in stuck detector
      this.stuckDetector.addEntry({
        stage: 'worker',
        success: workerResult.success,
        output: (workerResult.result as WorkerResult).summary,
        error: (workerResult.result as WorkerResult).error,
        timestamp: Date.now(),
      });

      if (!workerResult.success) {
        console.log(`[${context.taskPrefix}] Worker failed, retrying...`);
        agentPair.trackFailure(context.session.id); // Track for fresh context decision
        this.emit('iteration:fail', {
          iteration: context.currentIteration,
          stage: 'worker',
          context,
        });
        continue; // Next iteration
      }

      // ========== PIPELINE GUARDS (post-worker, pre-reviewer) ==========
      if (this.config.guards && context.workerResult) {
        console.log(`[${context.taskPrefix}] Running pipeline guards...`);
        const guardsResult = await runGuards(
          context.workerResult,
          context.projectPath,
          this.config.guards,
        );
        context.guardsResult = guardsResult;

        if (!guardsResult.allPassed) {
          // Blocking guard failed → bad edit. Skip the (expensive) reviewer and
          // drive a bounded self-repair retry with the exact errors preserved.
          const blocking = guardsResult.results.filter(r => !r.passed && r.blocking);
          const blockingIssues = blocking.flatMap(r => r.issues);
          console.log(`[${context.taskPrefix}] Blocking guard failed: ${blockingIssues.join('; ')}`);

          // qualityGate is the lint/type bad-edit check; bsDetector is code-smell.
          const source: ReflectionSource = blocking.some(r => r.guard === 'qualityGate') ? 'lint' : 'bs';
          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source,
            errors: blockingIssues,
          });

          context.reviewResult = {
            decision: 'revise',
            feedback: `Pipeline guard failed: ${blockingIssues.join('; ')}`,
            issues: blockingIssues,
            suggestions: ['Fix the issues flagged by quality guards'],
          };
          context.feedbackSource = 'objective';
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');

          if (this.shouldAbortSelfRepair(context, progressed, source)) {
            return { success: false };
          }
          continue;
        }

        // Log non-blocking guard warnings
        const warnings = guardsResult.results.filter(r => !r.passed && !r.blocking);
        if (warnings.length > 0) {
          console.log(`[${context.taskPrefix}] Guard warnings: ${warnings.map(w => w.guard).join(', ')}`);
          this.emit('log', {
            line: `⚠️ Guard warnings: ${warnings.flatMap(w => w.issues).join('; ')}`,
          });
        }
      }

      // ========== HALT CHECK (confidence too low) ==========
      if (context.workerResult) {
        const confidence = agentPair.calculateConfidence(context.workerResult);
        if (confidence < CONFIDENCE_THRESHOLDS.HALT) {
          const haltReason = context.workerResult.haltReason
            || `Low confidence: ${confidence}%`;
          console.warn(`[${context.taskPrefix}] HALT triggered: confidence=${confidence}%, reason=${haltReason}`);

          this.emit('halt', {
            confidence,
            haltReason,
            sessionId: context.session.id,
            iteration: context.currentIteration,
            context,
          });

          // Inject revise to retry. Low confidence is a subjective signal, so it
          // travels through the reviewer channel (dropped on a fresh-context reset).
          context.reviewResult = {
            decision: 'revise',
            feedback: `[HALT] Confidence too low (${confidence}%). ${haltReason}`,
            issues: [haltReason],
            suggestions: ['Review task requirements', 'Provide additional context', 'Break into sub-tasks'],
          };
          context.feedbackSource = 'review';
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
      }

      // ========== TESTER (before reviewer — INT-1703) ==========
      // Run the tester first so the reviewer judges code + test outcomes
      // together, and so a failing test drives INT-1679 self-repair WITHOUT
      // spending a reviewer pass. Runs exactly once per iteration.
      if (hasTester) {
        // Skip tester if no code files changed (configurable, default true)
        const skipIfNoCode = this.config.skipTesterIfNoCodeChange ?? true;
        const codeExtensions = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|c|cpp|h|hpp)$/;
        const changedFiles = context.workerResult?.filesChanged || [];
        const hasCodeChange = changedFiles.some(f => codeExtensions.test(f));
        if (skipIfNoCode && !hasCodeChange) {
          console.log(`[${context.taskPrefix}] Skipping tester: no code files changed (${changedFiles.length} files: ${changedFiles.join(', ') || 'none'})`);
        } else {
        const testerResult = await this.runStage('tester', context);
        stages.push(testerResult);

        if (!testerResult.success && !this.config.continueOnTestFail) {
          // Test failure is objective ground truth → record into the reflection
          // trail and drive a bounded self-repair retry (INT-1679).
          console.log(`[${context.taskPrefix}] Tester failed, retrying...`);
          agentPair.trackFailure(context.session.id); // Track for fresh context decision

          const failedTests = context.testerResult?.failedTests ?? [];
          const testErrors = failedTests.length > 0
            ? failedTests
            : [context.testerResult?.error || `Tests failed (${context.testerResult?.testsFailed ?? 0} failing)`];
          const { progressed } = recordReflection(context.reflection, {
            iteration: context.currentIteration,
            source: 'test',
            errors: testErrors,
          });

          if (context.testerResult) {
            context.reviewResult = {
              decision: 'revise',
              feedback: testerAgent.buildTestFixPrompt(context.testerResult),
              issues: context.testerResult.failedTests,
              suggestions: context.testerResult.suggestions,
            };
          }
          context.feedbackSource = 'objective';

          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'tester',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');

          if (this.shouldAbortSelfRepair(context, progressed, 'test')) {
            return { success: false };
          }
          continue;
        }
        } // end else (has code change)
      }

      // ========== REVIEWER ==========
      if (hasReviewer) {
        agentPair.updateSessionStatus(context.session.id, 'reviewing');

        // Reviewer escalation: 로컬 모델이 N회 이상 REVISE → 상위 모델로 spot check
        const reviewerCfg = this.config.roles?.reviewer;
        const reviewerEscalateModel = reviewerCfg?.escalateModel;
        const reviewerEscalateThreshold = reviewerCfg?.escalateAfterIteration ?? 3;
        const shouldEscalateReviewer = context.currentIteration >= reviewerEscalateThreshold && !!reviewerEscalateModel;

        const reviewerOverrides = shouldEscalateReviewer
          ? { model: reviewerEscalateModel }
          : undefined;

        if (shouldEscalateReviewer && reviewerEscalateModel) {
          console.log(`[${context.taskPrefix}] Reviewer escalation → ${reviewerEscalateModel} (iteration ${context.currentIteration})`);
          this.emit('log', {
            line: `🔍 Reviewer spot check: escalating to ${reviewerEscalateModel}`,
          });
        }

        const reviewerResult = await this.runStage('reviewer', context, reviewerOverrides);
        stages.push(reviewerResult);

        const decision = (reviewerResult.result as ReviewResult).decision;

        // Record Reviewer result in stuck detector
        this.stuckDetector.addEntry({
          stage: 'reviewer',
          success: reviewerResult.success,
          decision: decision,
          output: (reviewerResult.result as ReviewResult).feedback,
          timestamp: Date.now(),
        });

        if (decision === 'reject') {
          // reject = terminate immediately
          console.log(`[${context.taskPrefix}] Reviewer rejected`);
          agentPair.updateSessionStatus(context.session.id, 'rejected');
          return { success: false };
        }

        if (decision === 'revise') {
          // revise = next iteration. Reviewer feedback is subjective → it travels
          // through the reviewer channel and is dropped on a fresh-context reset.
          console.log(`[${context.taskPrefix}] Reviewer requested revision`);
          context.feedbackSource = 'review';
          agentPair.trackFailure(context.session.id); // Track for fresh context decision
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'reviewer',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        // approve → done (tester already ran before the reviewer — INT-1703)
        agentPair.resetFailureStreak(context.session.id); // Reset on approval
      }

      // ========== ALL PASSED ==========
      console.log(`[${context.taskPrefix}] Iteration ${context.currentIteration} completed successfully`);
      this.emit('iteration:complete', {
        iteration: context.currentIteration,
        context,
      });
      return { success: true };
    }

    // maxIterations exceeded
    console.log(`[${context.taskPrefix}] Max iterations (${maxIterations}) exceeded`);
    agentPair.updateSessionStatus(context.session.id, 'failed');
    return { success: false };
  }

  // ============================================
  // Result Building
  // ============================================

  /**
   * Build pipeline result
   */
  private buildResult(
    context: PipelineContext,
    stages: StageResult[],
    startTime: number
  ): PipelineResult {
    // Use context.session directly — do NOT re-fetch from store.
    // updateSessionStatus('approved') archives the session (deletes from Map),
    // so getPairSession() would return undefined → finalStatus = 'failed'.
    const session = context.session;
    const finalStatus = session.status as PipelineResult['finalStatus'] || 'failed';
    const success = finalStatus === 'approved';

    // Aggregate costs from all stages
    const stageCosts: (CostInfo | undefined)[] = [];
    if (context.workerResult?.costInfo) stageCosts.push(context.workerResult.costInfo);
    if (context.reviewResult?.costInfo) stageCosts.push(context.reviewResult.costInfo);
    if (context.testerResult?.costInfo) stageCosts.push(context.testerResult.costInfo);
    if (context.documenterResult?.costInfo) stageCosts.push(context.documenterResult.costInfo);
    if (context.auditorResult?.costInfo) stageCosts.push(context.auditorResult.costInfo);
    if (context.skillDocumenterResult?.costInfo) stageCosts.push(context.skillDocumenterResult.costInfo);
    const totalCost = stageCosts.length > 0 ? aggregateCosts(stageCosts) : undefined;

    if (totalCost) {
      console.log(`[${context.taskPrefix}] Total cost: ${formatCost(totalCost)}`);
      broadcastEvent({ type: 'task:cost', data: { taskId: context.task.id, cost: totalCost } });
    }

    const result: PipelineResult = {
      success,
      sessionId: context.session.id,
      stages,
      finalStatus,
      totalDuration: Date.now() - startTime,
      iterations: context.currentIteration,
      workerResult: context.workerResult,
      reviewResult: context.reviewResult,
      testerResult: context.testerResult,
      documenterResult: context.documenterResult,
      auditorResult: context.auditorResult,
      skillDocumenterResult: context.skillDocumenterResult,
      taskContext: {
        issueIdentifier: context.task.issueIdentifier || context.task.issueId,
        projectName: context.task.linearProject?.name,
        projectPath: context.projectPath,
        taskTitle: context.task.title,
      },
      totalCost,
    };

    if (success) {
      this.emit('pipeline:complete', result);
    } else {
      this.emit('pipeline:fail', result);
    }

    return result;
  }
}

// Factory Functions

/**
 * Create default pipeline (Worker + Reviewer)
 */
export function createDefaultPipeline(maxIterations = 3): PairPipeline {
  return new PairPipeline({
    stages: ['worker', 'reviewer'],
    maxIterations,
  });
}

/**
 * Create full pipeline (Worker + Reviewer + Tester + Documenter)
 */
export function createFullPipeline(
  config?: Partial<PipelineConfig>
): PairPipeline {
  return new PairPipeline({
    stages: ['worker', 'reviewer', 'tester', 'documenter'],
    maxIterations: 3,
    continueOnTestFail: false,
    skipDocumenterIfNoChange: true,
    ...config,
  });
}

/**
 * Create pipeline from configuration
 */
export function createPipelineFromConfig(
  roles: PipelineConfig['roles'],
  maxIterations = 3,
  guards?: Partial<PipelineGuardsConfig>,
  jobProfiles?: JobProfile[],
  draftAnalysis?: PipelineConfig['draftAnalysis'],
  maxReflections?: number,
  runMetadata?: PipelineRunMetadata,
): PairPipeline {
  const stages: PipelineStage[] = [];

  if (roles?.worker?.enabled !== false) {
    stages.push('worker');
  }
  if (roles?.reviewer?.enabled !== false) {
    stages.push('reviewer');
  }
  if (roles?.tester?.enabled) {
    stages.push('tester');
  }
  if (roles?.documenter?.enabled) {
    stages.push('documenter');
  }
  if (roles?.auditor?.enabled) {
    stages.push('auditor');
  }
  if (roles?.['skill-documenter']?.enabled) {
    stages.push('skill-documenter');
  }

  return new PairPipeline({
    stages,
    maxIterations,
    maxReflections,
    roles,
    guards,
    jobProfiles,
    draftAnalysis,
    runMetadata,
  });
}

function repoNameFromPath(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const normalized = projectPath.replace(/\/+$/, '').replace(/\/worktree\/[^/]+$/, '');
  return normalized.split('/').pop();
}

function worktreeNameFromPath(projectPath?: string): string | undefined {
  return projectPath?.match(/\/worktree\/([^/]+)\/?$/)?.[1];
}

// Helpers

/**
 * Extract a worker-readable summary of what the agent did during a stage so
 * the dashboard can display "wrote 4 files / approved / reviewed N issues"
 * instead of just "stage=worker status=complete".
 *
 * Returns a plain object suitable for inclusion in the SSE `pipeline:stage`
 * broadcast payload. Fields are optional — missing ones are simply omitted.
 */
function summarizeStageResult(
  stage: PipelineStage,
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult,
): Record<string, unknown> {
  // Cap arrays/strings before broadcasting so a chatty agent cannot blow up
  // the SSE channel with a 10MB stage event.
  const MAX_FILES = 12;
  const MAX_COMMANDS = 8;
  const SUMMARY_CAP = 240;
  const FEEDBACK_CAP = 480;
  const cap = (s: string | undefined, n: number): string | undefined =>
    s == null ? undefined : (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  switch (stage) {
    case 'worker': {
      const r = result as WorkerResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.filesChanged?.length ?? 0,
        commands: Array.isArray(r.commands) ? r.commands.slice(0, MAX_COMMANDS) : undefined,
        commandsCount: r.commands?.length ?? 0,
        confidencePercent: r.confidencePercent,
        haltReason: r.haltReason,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'reviewer': {
      const r = result as ReviewResult;
      return {
        decision: r.decision,
        feedback: cap(r.feedback, FEEDBACK_CAP),
        issuesCount: r.issues?.length ?? 0,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        suggestionsCount: r.suggestions?.length ?? 0,
      };
    }

    case 'tester': {
      const r = result as TesterResult;
      return {
        passed: r.testsPassed,
        failed: r.testsFailed,
        coverage: r.coverage,
        failedTests: Array.isArray(r.failedTests) ? r.failedTests.slice(0, MAX_FILES) : undefined,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'documenter': {
      const r = result as DocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        changelogEntry: cap(r.changelogEntry, SUMMARY_CAP),
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'auditor': {
      const r = result as AuditorResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        bsScore: r.bsScore,
        criticalCount: r.criticalCount,
        warningCount: r.warningCount,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        issuesCount: r.issues?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'skill-documenter': {
      const r = result as SkillDocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    default:
      return {};
  }
}

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
