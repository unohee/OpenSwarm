import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig, PipelineGuardsConfig, JobProfile } from '../core/types.js';
import type { CostInfo } from '../support/costTracker.js';
import type { WorkerResult, ReviewResult, PairSession } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { GuardsRunResult } from './pipelineGuards.js';
import type { ReflectionState } from './reflection.js';
import type { WorkerFanoutGateDecision } from './workerFanoutGate.js';

export interface PipelineRunMetadata {
  repository?: string;
  projectPath?: string;
  worktree?: string;
  branch?: string;
  issueIdentifier?: string;
  title?: string;
}

export interface PipelineConfig {
  stages: PipelineStage[];
  continueOnTestFail?: boolean;
  skipDocumenterIfNoChange?: boolean;
  maxIterations?: number;
  maxReflections?: number;
  roles?: {
    worker?: RoleConfig;
    reviewer?: RoleConfig;
    tester?: RoleConfig;
    documenter?: RoleConfig;
    auditor?: RoleConfig;
    'skill-documenter'?: RoleConfig;
  };
  guards?: Partial<PipelineGuardsConfig>;
  jobProfiles?: JobProfile[];
  runMetadata?: PipelineRunMetadata;
  skipTesterIfNoCodeChange?: boolean;
  skipAuditorUnderFileCount?: number;
  verbose?: boolean;
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

export interface StageResult {
  stage: PipelineStage;
  success: boolean;
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult | { success: false; error: string };
  duration: number;
  startedAt: number;
  completedAt: number;
}

export interface PipelineResult {
  success: boolean;
  sessionId: string;
  stages: StageResult[];
  finalStatus: 'approved' | 'rejected' | 'failed' | 'cancelled' | 'decomposed' | 'rate_limited' | 'infra_error';
  rateLimitResetsAt?: number;
  totalDuration: number;
  iterations: number;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  taskContext?: {
    issueIdentifier?: string;
    projectName?: string;
    projectPath?: string;
    taskTitle?: string;
  };
  prUrl?: string;
  totalCost?: CostInfo;
}

export interface PipelineContext {
  task: TaskItem;
  projectPath: string;
  session: PairSession;
  config: PipelineConfig;
  currentIteration: number;
  taskPrefix: string;
  workerResult?: WorkerResult;
  reviewResult?: ReviewResult;
  testerResult?: TesterResult;
  documenterResult?: DocumenterResult;
  auditorResult?: AuditorResult;
  skillDocumenterResult?: SkillDocumenterResult;
  guardsResult?: GuardsRunResult;
  reflection: ReflectionState;
  feedbackSource?: 'objective' | 'review';
  workerFanoutDecision?: WorkerFanoutGateDecision;
}

export type PipelineEventType = 'stage:start' | 'stage:complete' | 'stage:fail' | 'iteration:start' | 'iteration:complete' | 'iteration:fail' | 'pipeline:complete' | 'pipeline:fail' | 'fanout:gate' | 'halt';
