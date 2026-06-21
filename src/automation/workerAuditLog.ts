// ============================================
// OpenSwarm - Worker audit log
// ============================================
//
// Every worker run should leave an audit trail on the issue: what it was
// instructed to do (start) and what it actually did (complete). These build the
// comment bodies posted via ITaskSource.addComment, so they work for Linear AND
// the local SQLite task source (which writes addComment → addEvent). See INT-1612.

import type { WorkerResult } from '../agents/agentPair.js';

/** Caps so a chatty agent can't post a multi-MB comment. */
const MAX_FILES = 20;
const MAX_COMMANDS = 12;
const SUMMARY_CAP = 600;
const GOAL_CAP = 400;

function cap(s: string | undefined, n: number): string {
  if (!s) return '';
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n - 1)}…` : trimmed;
}

/** Render a list as inline code, capped, with an "+N more" suffix when truncated. */
function codeList(items: string[] | undefined, max: number): string {
  if (!items || items.length === 0) return '_(none)_';
  const shown = items.slice(0, max).map((i) => `\`${i}\``).join(', ');
  const extra = items.length - max;
  return extra > 0 ? `${shown} _+${extra} more_` : shown;
}

export interface WorkerStartInfo {
  /** 1-based iteration/attempt number. */
  attempt: number;
  maxAttempts?: number;
  taskTitle: string;
  /** Prompt summary — task description or draft intent summary. */
  taskGoal?: string;
  /** Files the worker is expected to touch (from draft analysis / impact). */
  targetFiles?: string[];
  /** Resolved model for this worker run. */
  model?: string;
  /** Max agentic turns (proxy for effort budget). */
  maxTurns?: number;
  /** True when this run follows reviewer/guard feedback (a revision). */
  isRevision?: boolean;
}

/** Comment body posted when a worker run starts (the instruction). */
export function buildWorkerStartComment(info: WorkerStartInfo): string {
  const attemptLabel = info.maxAttempts
    ? `attempt #${info.attempt}/${info.maxAttempts}`
    : `attempt #${info.attempt}`;
  const heading = info.isRevision ? 'Worker Revision' : 'Worker Instruction';

  const lines: string[] = [`🛠️ **[${heading}]** (${attemptLabel})`, ''];
  lines.push(`**Task:** ${cap(info.taskTitle, 200)}`);
  if (info.taskGoal) lines.push(`**Goal:** ${cap(info.taskGoal, GOAL_CAP)}`);
  if (info.targetFiles && info.targetFiles.length > 0) {
    lines.push(`**Target files:** ${codeList(info.targetFiles, MAX_FILES)}`);
  }

  const budget: string[] = [];
  if (info.model) budget.push(`model \`${info.model}\``);
  if (info.maxTurns) budget.push(`max turns ${info.maxTurns}`);
  if (budget.length > 0) lines.push(`**Effort:** ${budget.join(' · ')}`);

  lines.push('', '---', '_Auto-generated audit log_');
  return lines.join('\n');
}

export interface WorkerCompleteInfo {
  attempt: number;
  maxAttempts?: number;
  result: WorkerResult;
  /** Worker run duration in seconds. */
  durationSec?: number;
}

/** Comment body posted when a worker run completes (the actions taken). */
export function buildWorkerCompleteComment(info: WorkerCompleteInfo): string {
  const { result } = info;
  const attemptLabel = info.maxAttempts
    ? `attempt #${info.attempt}/${info.maxAttempts}`
    : `attempt #${info.attempt}`;
  const icon = result.haltReason ? '⚠️' : result.success ? '✅' : '❌';
  const verdict = result.haltReason ? 'Halted' : result.success ? 'Done' : 'Failed';

  const lines: string[] = [`${icon} **[Worker Actions — ${verdict}]** (${attemptLabel})`, ''];
  if (result.summary) lines.push(`**Summary:** ${cap(result.summary, SUMMARY_CAP)}`);

  const files = result.filesChanged ?? [];
  lines.push(`**Files changed (${files.length}):** ${codeList(files, MAX_FILES)}`);

  const commands = result.commands ?? [];
  if (commands.length > 0) {
    lines.push(`**Commands (${commands.length}):** ${codeList(commands, MAX_COMMANDS)}`);
  }

  if (result.confidencePercent != null) {
    lines.push(`**Confidence:** ${result.confidencePercent}%`);
  }
  if (info.durationSec != null) {
    const d = info.durationSec;
    lines.push(`**Duration:** ${d < 60 ? `${d}s` : `${Math.floor(d / 60)}m ${d % 60}s`}`);
  }
  if (result.haltReason) lines.push(`**Halt reason:** ${cap(result.haltReason, GOAL_CAP)}`);
  if (result.error) lines.push(`**Error:** ${cap(result.error, GOAL_CAP)}`);

  lines.push('', '---', '_Auto-generated audit log_');
  return lines.join('\n');
}
