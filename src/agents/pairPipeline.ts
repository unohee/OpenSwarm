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
import { hasRepoSnapshot, scanAndCache, analyzeIssue } from '../knowledge/index.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import type { WorkerContext } from '../locale/types.js';
import * as workerAgent from './worker.js';
import * as reviewerAgent from './reviewer.js';
import * as testerAgent from './tester.js';
import * as documenterAgent from './documenter.js';
import * as auditorAgent from './auditor.js';
import * as skillDocumenterAgent from './skillDocumenter.js';
import { StuckDetector, createStuckDetector } from '../support/stuckDetector.js';

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
    impactAnalysis?: import('../knowledge/types.js').ImpactAnalysis;
    registrySnapshot?: Array<{ filePath: string; summary: string; highlights: string[] }>;
  };
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
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed';
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

  constructor(config: PipelineConfig) {
    super();
    this.config = {
      continueOnTestFail: false,
      skipDocumenterIfNoChange: true,
      maxIterations: 3,
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

  // ============================================
  // Main Execution
  // ============================================

  /**
   * Run pipeline
   *
   * 1 iteration = full pass through Worker → Reviewer → Tester
   * On failure at any stage, returns to Worker (up to maxIterations)
   */
  async run(task: TaskItem, projectPath: string): Promise<PipelineResult> {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const maxIterations = this.config.maxIterations ?? 3;

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
      console.error(`[${context.taskPrefix}] Error:`, error);
      agentPair.updateSessionStatus(session.id, 'failed');
      return {
        success: false,
        sessionId: session.id,
        stages,
        finalStatus: 'failed',
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

      if (!wc.impactAnalysis && !wc.registryBriefs && !wc.draftAnalysis) return undefined;
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
    const stageModel = overrides?.model ?? this.getModelForRole(stage, context.task);
    const prefix = context.taskPrefix;
    console.log(`[${prefix}] Stage starting: ${stage}`);
    this.emit('stage:start', { stage, context });
    broadcastEvent({ type: 'pipeline:stage', data: { taskId: context.task.id, stage, status: 'start', model: stageModel } });

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

          result = await workerAgent.runWorker({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            projectPath: context.projectPath,
            previousFeedback: useFreshContext
              ? undefined // Fresh context: no previous feedback
              : (context.reviewResult
                  ? reviewerAgent.buildRevisionPrompt(context.reviewResult)
                  : undefined),
            timeoutMs: this.config.roles?.worker?.timeoutMs ?? 0,
            model: overrides?.model ?? this.config.roles?.worker?.model,
            maxTurns: this.config.roles?.worker?.maxTurns,
            adapterName: this.config.roles?.worker?.adapter,
            issueIdentifier: context.task.issueIdentifier || context.task.issueId,
            projectName: context.task.linearProject?.name,
            onLog,
            processContext: { taskId: context.task.id, stage: 'worker' },
            workerContext,
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
          // Proceed directly to full Sonnet review for reliability
          // Reduce review depth when worker confidence is very high
          let reviewerMaxTurns = this.config.roles?.reviewer?.maxTurns;
          if (context.workerResult?.confidencePercent && context.workerResult.confidencePercent > 90) {
            const cappedTurns = Math.min(reviewerMaxTurns ?? 10, 5);
            console.log(`[${prefix}] High worker confidence (${context.workerResult.confidencePercent}%), limiting reviewer to ${cappedTurns} turns`);
            reviewerMaxTurns = cappedTurns;
          }
          console.log(`[${prefix}] Running full review (Sonnet)...`);
          result = await reviewerAgent.runReviewer({
            taskTitle: context.task.title,
            taskDescription: context.task.description || '',
            workerResult: context.workerResult,
            projectPath: context.projectPath,
            timeoutMs: this.config.roles?.reviewer?.timeoutMs ?? 0,
            model: this.config.roles?.reviewer?.model,
            maxTurns: reviewerMaxTurns,
            adapterName: this.config.roles?.reviewer?.adapter,
            processContext: { taskId: context.task.id, stage: 'reviewer' },
          });

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
        model: costInfo?.model,
        inputTokens: costInfo?.inputTokens,
        outputTokens: costInfo?.outputTokens,
        costUsd: costInfo?.costUsd,
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
      broadcastEvent({ type: 'pipeline:stage', data: { taskId: context.task.id, stage, status: 'fail' } });
      return stageResult;
    }
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
      const escalateThreshold = workerCfg?.escalateAfterIteration ?? 3;
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
          // Blocking guard failed → inject revise, skip reviewer
          console.log(`[${context.taskPrefix}] Blocking guard failed: ${guardsResult.combinedIssues.join('; ')}`);
          context.reviewResult = {
            decision: 'revise',
            feedback: `Pipeline guard failed: ${guardsResult.combinedIssues.join('; ')}`,
            issues: guardsResult.combinedIssues,
            suggestions: ['Fix the issues flagged by quality guards'],
          };
          agentPair.trackFailure(context.session.id);
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'worker',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
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

          // Inject revise to retry
          context.reviewResult = {
            decision: 'revise',
            feedback: `[HALT] Confidence too low (${confidence}%). ${haltReason}`,
            issues: [haltReason],
            suggestions: ['Review task requirements', 'Provide additional context', 'Break into sub-tasks'],
          };
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
          // revise = next iteration
          console.log(`[${context.taskPrefix}] Reviewer requested revision`);
          agentPair.trackFailure(context.session.id); // Track for fresh context decision
          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'reviewer',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }

        // approve → proceed to Tester
        agentPair.resetFailureStreak(context.session.id); // Reset on approval
      }

      // ========== TESTER ==========
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
          // Test failed → set feedback then next iteration
          console.log(`[${context.taskPrefix}] Tester failed, retrying...`);
          agentPair.trackFailure(context.session.id); // Track for fresh context decision

          if (context.testerResult) {
            context.reviewResult = {
              decision: 'revise',
              feedback: testerAgent.buildTestFixPrompt(context.testerResult),
              issues: context.testerResult.failedTests,
              suggestions: context.testerResult.suggestions,
            };
          }

          this.emit('iteration:fail', {
            iteration: context.currentIteration,
            stage: 'tester',
            context,
          });
          agentPair.updateSessionStatus(context.session.id, 'revising');
          continue;
        }
        } // end else (has code change)
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
    roles,
    guards,
    jobProfiles,
    draftAnalysis,
  });
}

// Helpers

// Re-export formatting functions (extracted to pipelineFormat.ts)
export { formatPipelineResult, formatPipelineResultEmbed } from './pipelineFormat.js';
