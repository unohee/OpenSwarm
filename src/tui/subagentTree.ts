// ============================================
// OpenSwarm - Subagent tree (EPIC INT-1813 S7 / INT-1940)
// Pure grouping of pipeline stage entries into a per-task (per-worktree) tree —
// the Claude-Code-subagent view of concurrent runs. Derived from the existing
// taskId-keyed events (each worktree task = one node, its stages = children), so
// no new backend event stream is required to surface the tree.
// ============================================

import type { StageEntry } from './pipelineEvents.js';

export type TaskStatus = 'start' | 'complete' | 'fail';

export interface TaskNode {
  taskId: string;
  stages: StageEntry[];
  /** Rolled-up status: fail if any stage failed, complete if all complete, else running. */
  status: TaskStatus;
}

export function buildSubagentTree(stages: StageEntry[]): TaskNode[] {
  const byTask = new Map<string, StageEntry[]>();
  for (const s of stages) {
    const arr = byTask.get(s.taskId);
    if (arr) arr.push(s);
    else byTask.set(s.taskId, [s]);
  }
  return [...byTask.entries()].map(([taskId, taskStages]) => {
    const latestStages = latestByStage(taskStages);
    return {
      taskId,
      stages: latestStages,
      status: rollUp(latestStages),
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
