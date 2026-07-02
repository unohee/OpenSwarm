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
    };
    return { ...state, stages: [...state.stages, entry].slice(-MAX_STAGES) };
  }
  if (ev.type === 'log') {
    return { ...state, logs: [...state.logs, `[${ev.data.stage}] ${ev.data.line}`].slice(-MAX_LOGS) };
  }
  return state;
}
