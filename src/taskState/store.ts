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
  topoRank: z.number().int().nonnegative().optional(),
  linearState: z.string().optional(),
  execution: ExecutionStateSchema.default({ status: 'backlog', retryCount: 0 }),
  worktree: WorktreeStateSchema.default({}),
  updatedAt: z.string(),
});

const TaskStateStoreSchema = z.object({
  version: z.literal(1).default(1),
  tasks: z.record(z.string(), OpenSwarmTaskStateSchema).default({}),
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
  try {
    if (existsSync(path)) {
      const parsed = TaskStateStoreSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) {
        cache = parsed.data;
        return cache;
      }
    }
  } catch {
    // Fall back to empty store.
  }

  cache = {
    version: 1,
    tasks: {},
    updatedAt: new Date().toISOString(),
  };
  return cache;
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
  const merged: OpenSwarmTaskState = {
    ...current,
    ...patch,
    issueId,
    childIssueIds: patch.childIssueIds ?? current.childIssueIds ?? [],
    dependencyIssueIds: patch.dependencyIssueIds ?? current.dependencyIssueIds ?? [],
    dependencyTitles: patch.dependencyTitles ?? current.dependencyTitles ?? [],
    execution: {
      ...current.execution,
      ...(patch.execution || {}),
    },
    worktree: {
      ...current.worktree,
      ...(patch.worktree || {}),
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
  };
}

export function updateTaskLinearState(issueId: string, linearState: string): OpenSwarmTaskState {
  return upsertTaskState(issueId, { linearState });
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
    return {
      ready: false,
      blockedBy: [],
      reason: 'Task already decomposed into child issues',
    };
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

export function hydrateTaskStateFromComments(
  issueId: string,
  comments: Array<{ body: string; createdAt?: string }> = [],
): OpenSwarmTaskState | undefined {
  const latest = [...comments]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((comment) => parseTaskStateSyncComment(comment.body))
    .find((state): state is OpenSwarmTaskState => Boolean(state));

  if (!latest) return undefined;

  return upsertTaskState(issueId, latest);
}
