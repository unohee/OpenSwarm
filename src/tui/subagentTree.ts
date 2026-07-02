// ============================================
// OpenSwarm - Subagent tree (EPIC INT-1813 S7 / INT-1940)
// Pure grouping of pipeline stage entries into a repository → worktree → role tree.
// ============================================

import type { StageEntry } from './pipelineEvents.js';

export type TaskStatus = 'start' | 'complete' | 'fail';

export interface RoleNode {
  role: string;
  status: TaskStatus;
  model?: string;
  durationMs?: number;
  decision?: 'approve' | 'revise' | 'reject';
  summary?: string;
  activity?: string;
  rateLimitResetsAt?: number;
}

export interface WorktreeNode {
  taskId: string;
  issueIdentifier?: string;
  title?: string;
  branch?: string;
  worktree?: string;
  currentStage?: string;
  durationMs?: number;
  decision?: 'approve' | 'revise' | 'reject';
  roles: RoleNode[];
  /** Rolled-up status: fail if any stage failed, complete if all complete, else running. */
  status: TaskStatus;
}

export interface RepositoryNode {
  repository: string;
  projectPath?: string;
  worktrees: WorktreeNode[];
  status: TaskStatus;
}

export function buildSubagentTree(stages: StageEntry[]): RepositoryNode[] {
  const byRepository = new Map<string, Map<string, StageEntry[]>>();
  for (const s of stages) {
    const repository = s.repository ?? repoNameFromPath(s.projectPath) ?? 'unknown repository';
    const worktreeKey = s.issueIdentifier ?? inferIssueIdentifier(s.taskId) ?? s.taskId ?? s.worktree ?? s.branch;
    const repo = byRepository.get(repository) ?? new Map<string, StageEntry[]>();
    const arr = repo.get(worktreeKey);
    if (arr) {
      arr.push(s);
      repo.delete(worktreeKey);
      repo.set(worktreeKey, arr);
    } else {
      repo.set(worktreeKey, [s]);
    }
    byRepository.set(repository, repo);
  }

  return [...byRepository.entries()].map(([repository, worktreeMap]) => {
    const worktrees = [...worktreeMap.values()].map((worktreeStages) => {
      const latestStages = latestByStage(worktreeStages);
      const latest = latestStages[latestStages.length - 1];
      const roles = latestStages.map((stage) => ({
        role: displayRole(stage.stage),
        status: stage.status,
        model: stage.model,
        durationMs: stage.durationMs,
        decision: stage.decision,
        summary: stage.summary,
        activity: stage.activity,
        rateLimitResetsAt: stage.rateLimitResetsAt,
      }));
      const withMetadata = [...latestStages].reverse();
      return {
        taskId: latest?.taskId ?? worktreeStages[0]?.taskId ?? 'unknown-task',
        issueIdentifier: firstDefined(withMetadata, (stage) => stage.issueIdentifier) ?? inferIssueIdentifier(latest?.taskId) ?? latest?.taskId,
        title: firstDefined(withMetadata, (stage) => stage.title),
        branch: firstDefined(withMetadata, (stage) => stage.branch),
        worktree: firstDefined(withMetadata, (stage) => stage.worktree) ?? worktreeNameFromPath(latest?.projectPath),
        currentStage: latest ? displayRole(latest.stage) : undefined,
        durationMs: latest?.durationMs,
        decision: findLast(latestStages, (stage) => Boolean(stage.decision))?.decision,
        roles,
        status: rollUp(latestStages),
      };
    });
    return {
      repository,
      projectPath: worktrees.map((w) => w.worktree).find(Boolean) ? undefined : latestProjectPath(worktreeMap),
      worktrees,
      status: rollUp(worktrees.flatMap((w) => w.roles.map((role) => ({ status: role.status } as StageEntry)))),
    };
  });
}

function latestByStage(stages: StageEntry[]): StageEntry[] {
  const latest = new Map<string, StageEntry>();
  for (const stage of stages) {
    latest.delete(stage.stage);
    latest.set(stage.stage, stage);
  }
  return [...latest.values()];
}

function rollUp(stages: StageEntry[]): TaskStatus {
  if (stages.some((s) => s.status === 'fail')) return 'fail';
  if (stages.length > 0 && stages.every((s) => s.status === 'complete')) return 'complete';
  return 'start';
}

function displayRole(stage: string): string {
  if (stage === 'draft') return 'Drafter';
  if (stage === 'decompose') return 'Planner';
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function repoNameFromPath(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const normalized = projectPath.replace(/\/+$/, '');
  const beforeWorktree = normalized.replace(/\/worktree\/[^/]+$/, '');
  return beforeWorktree.split('/').pop();
}

function worktreeNameFromPath(projectPath?: string): string | undefined {
  return projectPath?.match(/\/worktree\/([^/]+)\/?$/)?.[1];
}

function inferIssueIdentifier(taskId?: string): string | undefined {
  return taskId?.match(/[A-Z]+-\d+/)?.[0];
}

function firstDefined<T>(items: StageEntry[], select: (item: StageEntry) => T | undefined): T | undefined {
  for (const item of items) {
    const value = select(item);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function latestProjectPath(worktreeMap: Map<string, StageEntry[]>): string | undefined {
  for (const stages of worktreeMap.values()) {
    const latest = findLast(stages, (stage) => Boolean(stage.projectPath));
    if (latest?.projectPath) return latest.projectPath;
  }
  return undefined;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return items[i];
  }
  return undefined;
}
