// ============================================
// OpenSwarm - Task source abstraction
// ============================================
//
// The autonomous runner was hardwired to Linear. This abstracts the runner's
// full Linear surface (fetch + state transitions + comment logging + sub-issue
// creation) behind ITaskSource so OpenSwarm runs with no external SaaS — falling
// back to the existing local SQLite issue store (INT-1577). TaskItem.source
// already supports 'local'.

import * as linear from '../linear/index.js';
import { getIssueStore } from '../issues/index.js';
import type { IIssueStore } from '../issues/sqliteStore.js';
import type { Issue, IssueStatus, IssuePriority } from '../issues/schema.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { enrichTaskFromState } from '../taskState/store.js';

/** The runner's task-state vocabulary (mirrors Linear's updateIssueState states). */
export type TaskState = 'In Progress' | 'In Review' | 'Done' | 'Backlog' | 'Todo';

/** Pair-completion stats (matches linear.logPairComplete). */
export interface PairCompleteStats {
  attempts: number;
  duration: number;
  filesChanged: string[];
  workerSummary?: string;
  workerCommands?: string[];
  reviewerFeedback?: string;
  reviewerDecision?: string;
  testResults?: { passed: number; failed: number; coverage?: number; failedTests?: string[] };
  remainingWork?: string;
}

export type SubIssueResult = { id: string; identifier: string; title: string } | { error: string };

/**
 * Everything the autonomous runner needs from its task tracker. LinearTaskSource
 * preserves today's behavior exactly (thin delegation); SqliteTaskSource backs
 * the same surface with the local store.
 */
export interface ITaskSource {
  readonly kind: 'linear' | 'local';
  fetchTasks(): Promise<TaskItem[]>;
  /** Create a top-level task/issue (used by the /plan cockpit to seed a parent). */
  createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult>;
  updateState(issueId: string, state: TaskState): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  createSubIssue(
    parentId: string,
    title: string,
    description: string,
    options?: { priority?: number; projectId?: string; estimatedMinutes?: number },
  ): Promise<SubIssueResult>;
  logPairStart(issueId: string, sessionId: string, projectPath: string): Promise<void>;
  logPairComplete(issueId: string, sessionId: string, stats: PairCompleteStats): Promise<void>;
  logBlocked(issueId: string, sessionName: string, reason: string): Promise<void>;
  /** Permanently park an issue the loop has given up on so it is not retried automatically. */
  logStuck(issueId: string, sessionName: string, reason: string): Promise<void>;
  /** Clear the stuck marker so the issue becomes eligible for retry again. */
  unstick(issueId: string): Promise<void>;
  logHalt(issueId: string, sessionId: string, confidence: number, iteration: number, reason: string): Promise<void>;
  markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number): Promise<void>;
}

// ---- Linear-backed (delegates to the existing linear.* — behavior unchanged) ----

export class LinearTaskSource implements ITaskSource {
  readonly kind = 'linear' as const;
  /** fetch is injected so the existing service.ts fetcher closure (slim mode,
   *  comment hydration, task-state enrichment) is preserved verbatim. */
  constructor(private readonly fetch: () => Promise<TaskItem[]>) {}

  fetchTasks(): Promise<TaskItem[]> { return this.fetch(); }
  async createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult> {
    // Pass projectId so createIssue links the issue AND resolves the project's team
    // (multi-team configs would otherwise hit "teamId must be a UUID"). (INT-2210)
    const r = await linear.createIssue(title, description, [], { projectId });
    return 'error' in r ? r : { id: r.id, identifier: r.identifier, title: r.title };
  }
  updateState(issueId: string, state: TaskState): Promise<void> { return linear.updateIssueState(issueId, state); }
  addComment(issueId: string, body: string): Promise<void> { return linear.addComment(issueId, body); }
  createSubIssue(parentId: string, title: string, description: string, options?: { priority?: number; projectId?: string; estimatedMinutes?: number }): Promise<SubIssueResult> {
    return linear.createSubIssue(parentId, title, description, options);
  }
  logPairStart(issueId: string, sessionId: string, projectPath: string): Promise<void> { return linear.logPairStart(issueId, sessionId, projectPath); }
  logPairComplete(issueId: string, sessionId: string, stats: PairCompleteStats): Promise<void> { return linear.logPairComplete(issueId, sessionId, stats); }
  logBlocked(issueId: string, sessionName: string, reason: string): Promise<void> { return linear.logBlocked(issueId, sessionName, reason); }
  logStuck(issueId: string, sessionName: string, reason: string): Promise<void> { return linear.logStuck(issueId, sessionName, reason); }
  unstick(issueId: string): Promise<void> { return linear.removeIssueLabel(issueId, linear.STUCK_LABEL); }
  logHalt(issueId: string, sessionId: string, confidence: number, iteration: number, reason: string): Promise<void> { return linear.logHalt(issueId, sessionId, confidence, iteration, reason); }
  markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number): Promise<void> { return linear.markAsDecomposed(issueId, subIssueCount, totalMinutes); }
}

// ---- SQLite-backed (local issue store, no external account) ----

const PRIORITY_TO_NUM: Record<IssuePriority, number> = { urgent: 1, high: 2, medium: 3, low: 4, none: 4 };
const STATUS_TO_STATE: Record<IssueStatus, TaskState> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', cancelled: 'Backlog',
};
const STATE_TO_STATUS: Record<TaskState, IssueStatus> = {
  'In Progress': 'in_progress', 'In Review': 'in_review', Done: 'done', Backlog: 'backlog', Todo: 'todo',
};

/** Map a local SQLite Issue → the runner's TaskItem. */
export function issueToTask(issue: Issue): TaskItem {
  return {
    id: issue.id,
    source: 'local',
    title: issue.title,
    description: issue.description,
    priority: PRIORITY_TO_NUM[issue.priority] ?? 3,
    issueId: issue.id,
    issueIdentifier: issue.linearIdentifier ?? issue.id,
    linearState: STATUS_TO_STATE[issue.status],
    parentId: issue.parentId,
    estimatedMinutes: issue.estimateMinutes,
    createdAt: new Date(issue.createdAt).getTime(),
  };
}

export class SqliteTaskSource implements ITaskSource {
  readonly kind = 'local' as const;
  constructor(private readonly store: IIssueStore, private readonly defaultProjectId = 'local') {}

  async fetchTasks(): Promise<TaskItem[]> {
    const { issues } = this.store.listIssues({ status: ['todo', 'in_progress'], limit: 200, offset: 0 });
    // Enrich from canonical task state so planner-declared fileScope (plus
    // dependency/topoRank data) reaches the runner — mirrors the Linear path.
    return issues.map((issue) => enrichTaskFromState(issueToTask(issue)));
  }
  async createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult> {
    try {
      const issue = this.store.createIssue({ projectId: projectId ?? this.defaultProjectId, title, description, status: 'todo' });
      return { id: issue.id, identifier: issue.id, title: issue.title };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async updateState(issueId: string, state: TaskState): Promise<void> {
    this.store.changeStatus(issueId, STATE_TO_STATUS[state]);
  }
  async addComment(issueId: string, body: string): Promise<void> {
    this.store.addEvent(issueId, 'commented', { content: body });
  }
  async createSubIssue(parentId: string, title: string, description: string, options?: { priority?: number; projectId?: string; estimatedMinutes?: number }): Promise<SubIssueResult> {
    const parent = this.store.getIssue(parentId);
    const numToPriority: Record<number, IssuePriority> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };
    try {
      const issue = this.store.createIssue({
        projectId: options?.projectId ?? parent?.projectId ?? this.defaultProjectId,
        title,
        description,
        status: 'todo',
        priority: numToPriority[options?.priority ?? 3] ?? 'medium',
        parentId,
        estimateMinutes: options?.estimatedMinutes,
      });
      return { id: issue.id, identifier: issue.id, title: issue.title };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async logPairStart(issueId: string, _sessionId: string, _projectPath: string): Promise<void> {
    await this.addComment(issueId, '🔄 [Automation] Pair started');
  }
  async logPairComplete(issueId: string, _sessionId: string, stats: PairCompleteStats): Promise<void> {
    await this.addComment(issueId, `✅ [Automation] Pair complete — ${stats.attempts} attempt(s), ${stats.filesChanged.length} file(s)`);
  }
  async logBlocked(issueId: string, _sessionName: string, reason: string): Promise<void> {
    await this.addComment(issueId, `🚧 [Automation] Blocked: ${reason}`);
  }
  async logStuck(issueId: string, _sessionName: string, reason: string): Promise<void> {
    await this.addComment(issueId, `🛑 [Automation] Stuck — retries exhausted: ${reason}`);
    await this.updateState(issueId, 'Backlog');
  }
  async unstick(_issueId: string): Promise<void> {
    // Local store has no label concept; recovery is via moving the issue back to an active state.
  }
  async logHalt(issueId: string, _sessionId: string, confidence: number, iteration: number, reason: string): Promise<void> {
    await this.addComment(issueId, `⚠️ [Automation] HALT (confidence ${confidence}%, attempt #${iteration}): ${reason}`);
  }
  async markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number): Promise<void> {
    await this.addComment(issueId, `🔀 [Automation] Decomposed into ${subIssueCount} sub-task(s) (~${totalMinutes}min)`);
    await this.updateState(issueId, 'Backlog');
  }
}

/**
 * Pick the task source: Linear when configured (preserving its fetcher closure),
 * else the local SQLite store. Called from service startup.
 */
export function selectTaskSource(linearConfigured: boolean, linearFetch: () => Promise<TaskItem[]>): ITaskSource {
  if (linearConfigured) return new LinearTaskSource(linearFetch);
  return new SqliteTaskSource(getIssueStore());
}
