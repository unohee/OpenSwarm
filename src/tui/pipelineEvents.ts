// ============================================
// OpenSwarm - Pipeline event reducer (EPIC INT-1813 S5 / INT-1938)
// Pure reduction of HubEvents into the state the Pipeline tab renders — stage
// timeline + live log. No React/ink/network; unit-testable.
// ============================================

import type { HubEvent } from '../core/eventHub.js';

export interface StageEntry {
  taskId: string;
  stage: string;
  status: 'start' | 'complete' | 'fail';
  repository?: string;
  projectPath?: string;
  worktree?: string;
  branch?: string;
  issueIdentifier?: string;
  title?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  decision?: 'approve' | 'revise' | 'reject';
  summary?: string;
  activity?: string;
  rateLimitResetsAt?: number;
}

export interface PipelineState {
  stages: StageEntry[]; // chronological, capped at MAX_STAGES
  logs: string[];       // recent log lines, capped at MAX_LOGS
}

export const MAX_STAGES = 100;
export const MAX_LOGS = 200;

export const initialPipelineState: PipelineState = { stages: [], logs: [] };

/** Fold one HubEvent into pipeline state (reducer shape: (state, action)). */
export function reducePipelineEvent(state: PipelineState, ev: HubEvent): PipelineState {
  if (ev.type === 'pipeline:stage') {
    const d = ev.data;
    const entry: StageEntry = {
      taskId: d.taskId,
      stage: d.stage,
      status: d.status,
      repository: d.repository,
      projectPath: d.projectPath,
      worktree: d.worktree,
      branch: d.branch,
      issueIdentifier: d.issueIdentifier,
      title: d.title,
      model: d.model,
      durationMs: d.durationMs,
      costUsd: d.costUsd,
      decision: d.decision,
      summary: d.summary,
      activity: d.status === 'start' ? 'waiting' : activityFromStage(d.error),
      rateLimitResetsAt: d.rateLimitResetsAt,
    };
    return { ...state, stages: [...state.stages, entry].slice(-MAX_STAGES) };
  }
  if (ev.type === 'log') {
    const activity = classifyActivity(ev.data.line);
    return {
      ...state,
      stages: activity
        ? updateLatestActivity(state.stages, ev.data.taskId, ev.data.stage, activity)
        : state.stages,
      logs: [...state.logs, `[${ev.data.stage}] ${ev.data.line}`].slice(-MAX_LOGS),
    };
  }
  if (ev.type === 'process:spawn') {
    return {
      ...state,
      stages: updateLatestActivity(state.stages, ev.data.taskId, ev.data.stage, 'waiting', ev.data.model),
    };
  }
  if (ev.type === 'process:exit') {
    if (!ev.data.taskId || !ev.data.stage) return state;
    return {
      ...state,
      stages: state.stages.map((stage) => stage.taskId === ev.data.taskId && stage.stage === ev.data.stage && stage.activity === 'waiting'
        ? { ...stage, activity: undefined }
        : stage),
    };
  }
  return state;
}

export function classifyActivity(line: string): string | undefined {
  const text = line.trim();
  const lower = text.toLowerCase();
  if (/\b(rate[-\s]?limit|quota|429)\b/.test(lower)) return 'rate-limited';
  const tool = text.match(/(?:tool[:\s]+|🔧\s*)([a-zA-Z_][\w-]*)/);
  if (tool) return `tool: ${tool[1]}`;
  if (/\b(apply_patch|read_file|write_file|edit_file|bash|shell|rg|grep)\b/.test(lower)) {
    const matched = lower.match(/\b(apply_patch|read_file|write_file|edit_file|bash|shell|rg|grep)\b/);
    return matched ? `tool: ${matched[1]}` : 'tool';
  }
  if (/\b(reasoning|thinking|analyzing|checking|planning)\b/.test(lower) || text.startsWith('💭')) return 'thinking';
  if (/\b(waiting|pending|queued)\b/.test(lower)) return 'waiting';
  return undefined;
}

function activityFromStage(error: string | undefined): string | undefined {
  return error ? classifyActivity(error) : undefined;
}

function updateLatestActivity(
  stages: StageEntry[],
  taskId: string,
  stageName: string,
  activity: string,
  model?: string,
): StageEntry[] {
  for (let i = stages.length - 1; i >= 0; i--) {
    const stage = stages[i];
    if (stage.taskId !== taskId || stage.stage !== stageName || stage.status !== 'start') continue;
    const next = stages.slice();
    next[i] = {
      ...stage,
      activity,
      model: stage.model ?? model,
    };
    return next;
  }
  return stages;
}
