// ============================================
// OpenSwarm - Autonomous Runner Types
// ============================================

import type { DecisionResult, TaskItem } from '../orchestration/decisionEngine.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import type { DefaultRolesConfig, ProjectAgentConfig, JobProfile } from '../core/types.js';

export interface AutonomousConfig {
  defaultAdapter?: 'claude' | 'codex';
  linearTeamId: string;
  allowedProjects: string[];
  heartbeatSchedule: string;
  autoExecute: boolean;
  discordChannelId?: string;
  maxConsecutiveTasks: number;
  cooldownSeconds: number;
  dryRun: boolean;
  pairMode?: boolean;
  pairMaxAttempts?: number;
  workerModel?: string;
  reviewerModel?: string;
  workerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  triggerNow?: boolean;
  maxConcurrentTasks?: number;
  defaultRoles?: DefaultRolesConfig;
  projectAgents?: ProjectAgentConfig[];
  enableDecomposition?: boolean;
  decompositionThresholdMinutes?: number;
  plannerModel?: string;
  plannerTimeoutMs?: number;
  decomposition?: import('../core/types.js').DecompositionConfig;
  worktreeMode?: boolean;
  guards?: Partial<import('../core/types.js').PipelineGuardsConfig>;
  /** Per-project task cap in 5h rolling window (default: 6) */
  dailyTaskCap?: number;
  /** Cooldown between task completions in ms (default: 1800000 = 30min) */
  interTaskCooldownMs?: number;
  jobProfiles?: JobProfile[];
}

export interface RunnerState {
  isRunning: boolean;
  lastHeartbeat: number;
  lastDecision?: DecisionResult;
  lastExecution?: ExecutorResult;
  pendingApproval?: TaskItem;
  consecutiveErrors: number;
  startedAt?: number;
}
