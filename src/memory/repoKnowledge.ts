// ============================================
// OpenSwarm - Repository Knowledge (repo-scoped memory)
// Created: 2026-06-10
// Purpose: Make repository understanding accumulate across tasks — extract repo
//          knowledge from task outcomes (write) and inject it into the next
//          task's worker prompt (read). Storage reuses the existing memoryCore
//          (LanceDB, repo field) — no new storage layer.
//          vega-agent pattern: relevance-based dynamic injection rather than a
//          fixed persona block.
// ============================================

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { saveMemory, searchMemorySafe } from './memoryCore.js';
import type { WorkerResult } from '../agents/agentPair.js';

/**
 * Normalize a project path into a stable repo key. The LanceDB repo filter is
 * an exact string match, so trailing slashes or symlinked paths to the same
 * repo would otherwise split the knowledge across keys that never match.
 */
export function repoKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved; // path may not exist yet (tests, dry runs) — resolve is enough
  }
}

/** Repo knowledge item injected into the worker prompt (mirrors locale WorkerContext) */
export interface RepoMemoryBrief {
  type: string;     // system_pattern | constraint | fact ...
  title: string;
  content: string;
}

/** Per-memory content cap at injection time — keeps long retros from eating the prompt */
const MAX_CONTENT_CHARS = 400;
const RECALL_LIMIT = 5;

/**
 * Recall repo knowledge relevant to the current task.
 * Always non-blocking — the pipeline runs even if memory is empty or the DB is down.
 */
export async function recallRepoKnowledge(
  projectPath: string,
  taskTitle: string,
  taskDescription: string,
): Promise<RepoMemoryBrief[]> {
  try {
    const query = `${taskTitle}\n${taskDescription}`.slice(0, 500);
    const result = await searchMemorySafe(query, {
      repo: repoKey(projectPath),
      // Include 'belief' — memories from other write paths may have been
      // distilled down to belief and would otherwise be filtered out.
      types: ['system_pattern', 'constraint', 'fact', 'strategy', 'belief'],
      limit: RECALL_LIMIT,
      minSimilarity: 0.35,
    });
    if (!result.success) return [];
    return result.memories.map((m) => ({
      type: m.type,
      title: m.title,
      content: m.content.length > MAX_CONTENT_CHARS
        ? m.content.slice(0, MAX_CONTENT_CHARS) + '…'
        : m.content,
    }));
  } catch {
    return [];
  }
}

export interface TaskOutcomeInput {
  taskTitle: string;
  /** Provenance tracker, e.g. Linear issue ID */
  derivedFrom?: string;
  workerResult?: Pick<WorkerResult, 'filesChanged' | 'commands' | 'summary'> | null;
  /** Reviewer rejection reason — stored as a constraint (pitfall) when present */
  rejectionFeedback?: string;
  /** Pipeline iteration count (1 = passed on the first attempt) */
  iterations?: number;
}

/**
 * Extract and store repo knowledge from a task outcome.
 * - Success: which files changed and how it passed → system_pattern (a shortcut
 *   for the next similar task)
 * - Rejection: the pitfall the reviewer flagged → constraint (blocks repeating
 *   the same mistake)
 * skipDistillation: this is already structured knowledge — distillation would
 * downgrade the type to 'belief' and drop it from type-filtered recall.
 */
export async function recordTaskOutcome(
  projectPath: string,
  outcome: TaskOutcomeInput,
): Promise<void> {
  try {
    const repo = repoKey(projectPath);
    if (outcome.rejectionFeedback) {
      await saveMemory(
        'constraint',
        repo,
        `Review rejection: ${outcome.taskTitle.slice(0, 80)}`,
        `Task "${outcome.taskTitle}" was rejected by the reviewer.\n` +
        `Reviewer feedback (avoid repeating this): ${outcome.rejectionFeedback.slice(0, 600)}`,
        { derivedFrom: outcome.derivedFrom, isVerified: true, skipDistillation: true },
      );
      return;
    }

    const files = outcome.workerResult?.filesChanged ?? [];
    if (files.length === 0) return; // nothing to learn from a task that changed no files

    const parts = [
      `Task "${outcome.taskTitle}" completed successfully.`,
      `Files changed: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` (+${files.length - 10} more)` : ''}.`,
    ];
    if (outcome.workerResult?.summary) {
      parts.push(`Approach: ${outcome.workerResult.summary.slice(0, 400)}`);
    }
    if (outcome.iterations && outcome.iterations > 1) {
      parts.push(`Took ${outcome.iterations} iterations before passing review.`);
    }
    await saveMemory(
      'system_pattern',
      repo,
      `Solved: ${outcome.taskTitle.slice(0, 80)}`,
      parts.join('\n'),
      { derivedFrom: outcome.derivedFrom, isVerified: true, skipDistillation: true },
    );
  } catch (err) {
    // Memory write failures must never stop the pipeline
    console.warn('[RepoKnowledge] recordTaskOutcome failed (non-critical):', err);
  }
}
