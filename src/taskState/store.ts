// ============================================
// OpenSwarm - Canonical Task State Store
// ============================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const TASK_STATE_MARKER = '<!-- openswarm:task-state:v1 -->';

const TaskExecutionStatusSchema = z.enum([
  'backlog',
  'todo',
  'ready',
  'blocked',
  'in_progress',
  'in_review',
  'decomposed',
  'done',
  'failed',
  'halted',
]);

const WorktreeStateSchema = z.object({
  branchName: z.string().optional(),
  worktreePath: z.string().optional(),
  ownerAgent: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
});

const ExecutionStateSchema = z.object({
  status: TaskExecutionStatusSchema.default('backlog'),
  blockedReason: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  confidence: z.number().min(0).max(1).optional(),
  lastSessionId: z.string().optional(),
});

export const OpenSwarmTaskStateSchema = z.object({
  version: z.literal(1).default(1),
  issueId: z.string(),
  issueIdentifier: z.string().optional(),
  title: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  parentIssueId: z.string().optional(),
  childIssueIds: z.array(z.string()).default([]),
  dependencyIssueIds: z.array(z.string()).default([]),
  dependencyTitles: z.array(z.string()).default([]),
  // Files/modules this task will touch (declared by the planner). Drives
  // file-scope overlap detection so non-overlapping tasks run concurrently.
  fileScope: z.array(z.string()).default([]),
  topoRank: z.number().int().nonnegative().optional(),
  linearState: z.string().optional(),
  execution: ExecutionStateSchema.default({ status: 'backlog', retryCount: 0 }),
  worktree: WorktreeStateSchema.default({}),
  updatedAt: z.string(),
});

function createTaskMap(
  entries: Iterable<[string, z.infer<typeof OpenSwarmTaskStateSchema>]> = [],
): Record<string, z.infer<typeof OpenSwarmTaskStateSchema>> {
  const tasks: Record<string, z.infer<typeof OpenSwarmTaskStateSchema>> = Object.create(null);
  for (const [issueId, state] of entries) {
    tasks[issueId] = state;
  }
  return tasks;
}

const TaskStateStoreSchema = z.object({
  version: z.literal(1).default(1),
  tasks: z.preprocess(
    (value) => {
      if (value === undefined) return [];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(value as Record<string, unknown>);
      }
      return value;
    },
    z.array(z.tuple([z.string(), OpenSwarmTaskStateSchema]))
      .transform((entries) => createTaskMap(entries))
  ).default(() => createTaskMap()),
  updatedAt: z.string(),
});

export type TaskExecutionStatus = z.infer<typeof TaskExecutionStatusSchema>;
export type OpenSwarmTaskState = z.infer<typeof OpenSwarmTaskStateSchema>;
type TaskStateStore = z.infer<typeof TaskStateStoreSchema>;

let cache: TaskStateStore | null = null;

function getStorePath(): string {
  return process.env.OPENSWARM_TASK_STATE_FILE || join(homedir(), '.openswarm', 'task-state.json');
}

function ensureStoreLoaded(): TaskStateStore {
  if (cache) return cache;

  const path = getStorePath();
  if (existsSync(path)) {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Task state store is corrupt at ${path}: ${message}`);
    }

    const parsed = TaskStateStoreSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Task state store is invalid at ${path}: ${parsed.error.message}`);
    }

    cache = parsed.data;
    return cache;
  }

  cache = {
    version: 1,
    tasks: createTaskMap(),
    updatedAt: new Date().toISOString(),
  };
  return cache;
}

export function resetTaskStateStoreForTests(): void {
  cache = null;
}

function persistStore(): void {
  const store = ensureStoreLoaded();
  store.updatedAt = new Date().toISOString();
  const path = getStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
}

function createDefaultState(issueId: string): OpenSwarmTaskState {
  return {
    version: 1,
    issueId,
    childIssueIds: [],
    dependencyIssueIds: [],
    dependencyTitles: [],
    fileScope: [],
    execution: {
      status: 'backlog',
      retryCount: 0,
    },
    worktree: {},
    updatedAt: new Date().toISOString(),
  };
}

export function getTaskState(issueId: string): OpenSwarmTaskState | undefined {
  return ensureStoreLoaded().tasks[issueId];
}

export function listTaskStates(): OpenSwarmTaskState[] {
  return Object.values(ensureStoreLoaded().tasks);
}

export function upsertTaskState(issueId: string, patch: Partial<OpenSwarmTaskState>): OpenSwarmTaskState {
  const store = ensureStoreLoaded();
  const current = store.tasks[issueId] || createDefaultState(issueId);
  const { execution, worktree, ...topLevelPatch } = patch;
  const definedTopLevelPatch = Object.fromEntries(
    Object.entries(topLevelPatch).filter(([, value]) => value !== undefined)
  ) as Partial<OpenSwarmTaskState>;
  const merged: OpenSwarmTaskState = {
    ...current,
    ...definedTopLevelPatch,
    issueId,
    childIssueIds: patch.childIssueIds ?? current.childIssueIds ?? [],
    dependencyIssueIds: patch.dependencyIssueIds ?? current.dependencyIssueIds ?? [],
    dependencyTitles: patch.dependencyTitles ?? current.dependencyTitles ?? [],
    fileScope: patch.fileScope ?? current.fileScope ?? [],
    execution: {
      ...current.execution,
      ...(execution),
    },
    worktree: {
      ...current.worktree,
      ...(worktree),
    },
    updatedAt: new Date().toISOString(),
  };

  store.tasks[issueId] = OpenSwarmTaskStateSchema.parse(merged);
  persistStore();
  return store.tasks[issueId];
}

export function enrichTaskFromState(task: TaskItem): TaskItem {
  const issueId = task.issueId || task.id;
  const state = getTaskState(issueId);
  if (!state) return task;

  return {
    ...task,
    parentId: task.parentId || state.parentIssueId,
    blockedBy: task.blockedBy && task.blockedBy.length > 0 ? task.blockedBy : state.dependencyIssueIds,
    topoRank: task.topoRank ?? state.topoRank,
    linearState: task.linearState || state.linearState,
    fileScope: task.fileScope && task.fileScope.length > 0 ? task.fileScope : state.fileScope,
  };
}

export function updateTaskLinearState(issueId: string, linearState: string): OpenSwarmTaskState {
  // R5: reconcile stale local execution status against Linear (the source of
  // truth). If Linear parks, reopens, or completes an issue while local state is
  // stale, downgrade it so dependencies do not stay incorrectly resolved or
  // actively running. This is a local-only update; it never writes back to
  // Linear (preserves R7).
  const patch: Partial<OpenSwarmTaskState> = { linearState };
  const current = getTaskState(issueId);
  if (current?.execution.status === 'in_progress' || current?.execution.status === 'done') {
    if (linearState === 'Done') {
      patch.execution = { ...current.execution, status: 'done' };
    } else if (linearState === 'In Progress') {
      patch.execution = { ...current.execution, status: 'in_progress' };
    } else if (linearState === 'Todo') {
      patch.execution = { ...current.execution, status: 'todo' };
    } else if (linearState === 'Backlog' || linearState === 'Canceled' || linearState === 'Cancelled') {
      patch.execution = { ...current.execution, status: 'backlog' };
    }
  }
  return upsertTaskState(issueId, patch);
}

export function markTaskInProgress(
  issueId: string,
  patch: {
    issueIdentifier?: string;
    title?: string;
    projectId?: string;
    projectName?: string;
    linearState?: string;
    sessionId?: string;
    branchName?: string;
    worktreePath?: string;
  } = {},
): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    issueIdentifier: patch.issueIdentifier,
    title: patch.title,
    projectId: patch.projectId,
    projectName: patch.projectName,
    linearState: patch.linearState ?? 'In Progress',
    execution: {
      status: 'in_progress',
      blockedReason: undefined,
      retryCount: 0,
      lastSessionId: patch.sessionId,
    },
    worktree: {
      branchName: patch.branchName,
      worktreePath: patch.worktreePath,
    },
  });
}

export function markTaskBacklog(
  issueId: string,
  patch: {
    issueIdentifier?: string;
    title?: string;
    linearState?: string;
  } = {},
): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    issueIdentifier: patch.issueIdentifier,
    title: patch.title,
    linearState: patch.linearState ?? 'Backlog',
    execution: {
      status: 'backlog',
      blockedReason: undefined,
      retryCount: 0,
    },
    worktree: {
      branchName: undefined,
      worktreePath: undefined,
    },
  });
}

export function markTaskDone(
  issueId: string,
  patch: {
    issueIdentifier?: string;
    title?: string;
    confidence?: number;
    linearState?: string;
  } = {},
): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    issueIdentifier: patch.issueIdentifier,
    title: patch.title,
    linearState: patch.linearState ?? 'Done',
    execution: {
      status: 'done',
      blockedReason: undefined,
      retryCount: 0,
      confidence: patch.confidence,
    },
  });
}

export function markTaskBlocked(
  issueId: string,
  reason: string,
  dependencyIssueIds: string[] = [],
  linearState?: string,
): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    dependencyIssueIds,
    linearState,
    execution: {
      status: 'blocked',
      blockedReason: reason,
      retryCount: 0,
    },
  });
}

export function markTaskFailed(issueId: string, reason: string, linearState?: string): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    linearState,
    execution: {
      status: 'failed',
      blockedReason: reason,
      retryCount: 0,
    },
  });
}

export function markTaskDecomposed(
  issueId: string,
  patch: {
    issueIdentifier?: string;
    title?: string;
    projectId?: string;
    projectName?: string;
    parentIssueId?: string;
    childIssueIds: string[];
  },
): OpenSwarmTaskState {
  return upsertTaskState(issueId, {
    issueIdentifier: patch.issueIdentifier,
    title: patch.title,
    projectId: patch.projectId,
    projectName: patch.projectName,
    parentIssueId: patch.parentIssueId,
    childIssueIds: patch.childIssueIds,
    execution: {
      status: 'decomposed',
      blockedReason: undefined,
      retryCount: 0,
    },
    linearState: 'In Progress',
  });
}

function isResolved(state: OpenSwarmTaskState | undefined): boolean {
  if (!state) return false;
  return state.execution.status === 'done' || state.linearState === 'Done';
}

export function getTaskReadiness(task: TaskItem): {
  ready: boolean;
  blockedBy: string[];
  reason?: string;
} {
  const issueId = task.issueId || task.id;
  const state = getTaskState(issueId);
  const dependencyIssueIds = task.blockedBy && task.blockedBy.length > 0
    ? task.blockedBy
    : state?.dependencyIssueIds || [];

  if (state?.execution.status === 'decomposed') {
    // If Linear state was manually changed back to actionable, allow re-execution.
    // `In Review` is treated as actionable too — reviewer feedback on a
    // decomposed task should get picked up rather than ignored.
    const linearState = task.linearState || state.linearState;
    const reactivated =
      linearState === 'Todo' ||
      linearState === 'In Progress' ||
      linearState === 'In Review';
    if (!reactivated) {
      return {
        ready: false,
        blockedBy: [],
        reason: 'Task already decomposed into child issues',
      };
    }
    // Decomposed but Linear state is actionable — allow execution
    console.log(`[TaskState] ${task.issueIdentifier}: decomposed but Linear state is "${linearState}", allowing re-execution`);
  }

  if (dependencyIssueIds.length === 0) {
    return { ready: true, blockedBy: [] };
  }

  const unresolved = dependencyIssueIds.filter((depId) => !isResolved(getTaskState(depId)));
  if (unresolved.length > 0) {
    return {
      ready: false,
      blockedBy: unresolved,
      reason: `Waiting on dependencies: ${unresolved.join(', ')}`,
    };
  }

  return { ready: true, blockedBy: [] };
}

export function releaseDependentTasks(completedIssueId: string): OpenSwarmTaskState[] {
  const store = ensureStoreLoaded();
  const released: OpenSwarmTaskState[] = [];

  for (const state of Object.values(store.tasks)) {
    if (!state.dependencyIssueIds.includes(completedIssueId)) continue;

    const unresolved = state.dependencyIssueIds.filter((depId) => !isResolved(store.tasks[depId]));
    if (unresolved.length > 0) {
      upsertTaskState(state.issueId, {
        execution: {
          status: 'blocked',
          blockedReason: `Waiting on dependencies: ${unresolved.join(', ')}`,
          retryCount: state.execution.retryCount,
        },
      });
      continue;
    }

    const next = upsertTaskState(state.issueId, {
      execution: {
        status: 'todo',
        blockedReason: undefined,
        retryCount: state.execution.retryCount,
      },
      linearState: 'Todo',
    });
    released.push(next);
  }

  return released;
}

export function completeParentIfChildrenDone(childIssueId: string): OpenSwarmTaskState | null {
  const childState = getTaskState(childIssueId);
  if (!childState?.parentIssueId) return null;

  const parentState = getTaskState(childState.parentIssueId);
  if (!parentState || parentState.childIssueIds.length === 0) return null;

  const allDone = parentState.childIssueIds.every((id) => isResolved(getTaskState(id)));
  if (!allDone) return null;

  return upsertTaskState(parentState.issueId, {
    linearState: 'Done',
    execution: {
      status: 'done',
      blockedReason: undefined,
      retryCount: parentState.execution.retryCount,
    },
  });
}

export function buildTaskStateSyncComment(state: OpenSwarmTaskState, headline: string): string {
  const deps = state.dependencyIssueIds.length > 0 ? state.dependencyIssueIds.join(', ') : '(none)';
  const children = state.childIssueIds.length > 0 ? state.childIssueIds.join(', ') : '(none)';

  return [
    `🧭 **[OpenSwarm] ${headline}**`,
    '',
    `- Status: \`${state.execution.status}\``,
    `- Linear state: \`${state.linearState || 'unknown'}\``,
    `- Parent: \`${state.parentIssueId || 'none'}\``,
    `- Dependencies: \`${deps}\``,
    `- Children: \`${children}\``,
    '',
    TASK_STATE_MARKER,
    '```json',
    JSON.stringify(state, null, 2),
    '```',
  ].join('\n');
}

export function parseTaskStateSyncComment(body: string): OpenSwarmTaskState | null {
  if (!body.includes(TASK_STATE_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;

  try {
    return OpenSwarmTaskStateSchema.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

type TaskStateSyncComment = {
  body: string;
  createdAt?: string;
  user?: string;
  author?: string;
  source?: string;
};

function trustedSyncCommentUsers(): Set<string> {
  return new Set(
    (process.env.OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isTrustedTaskStateSyncComment(comment: TaskStateSyncComment): boolean {
  if (!comment.body.includes(TASK_STATE_MARKER)) return false;
  if (!comment.body.startsWith('🧭 **[OpenSwarm] ')) return false;

  if (comment.source === 'openswarm') return true;

  // The Linear fetcher does not resolve comment authors yet (user: undefined) —
  // when no author info exists at all, fall back to the marker/prefix checks
  // above (status quo) instead of silently dropping every sync comment.
  if (comment.user === undefined && comment.author === undefined && comment.source === undefined) return true;

  const author = (comment.user || comment.author || '').trim().toLowerCase();
  if (!author) return false;

  if (trustedSyncCommentUsers().has(author)) return true;
  return author.includes('openswarm') || author.includes('open swarm');
}

export function hydrateTaskStateFromComments(
  issueId: string,
  comments: TaskStateSyncComment[] = [],
): OpenSwarmTaskState | undefined {
  const latest = [...comments]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .filter(isTrustedTaskStateSyncComment)
    .map((comment) => parseTaskStateSyncComment(comment.body))
    .find((state): state is OpenSwarmTaskState => state !== null && state.issueId === issueId);

  if (!latest) return undefined;

  return upsertTaskState(issueId, latest);
}
