import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  upsertTaskState,
  getTaskReadiness,
  releaseDependentTasks,
  enrichTaskFromState,
  markTaskDone,
  completeParentIfChildrenDone,
  buildTaskStateSyncComment,
  hydrateTaskStateFromComments,
} from './store.js';

describe('task state store', () => {
  const stateFile = `/tmp/openswarm-task-state-${process.pid}.json`;

  beforeEach(() => {
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
  });

  afterEach(() => {
    delete process.env.OPENSWARM_TASK_STATE_FILE;
  });

  it('enriches a task with canonical dependency data', () => {
    upsertTaskState('ISSUE-2', {
      issueIdentifier: 'INT-2',
      dependencyIssueIds: ['ISSUE-1'],
      parentIssueId: 'PARENT-1',
      topoRank: 1,
      execution: { status: 'blocked', retryCount: 0 },
      updatedAt: new Date().toISOString(),
    });

    const task = enrichTaskFromState({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });

    expect(task.parentId).toBe('PARENT-1');
    expect(task.blockedBy).toEqual(['ISSUE-1']);
    expect(task.topoRank).toBe(1);
  });

  it('keeps tasks blocked until dependencies are done, then releases them', () => {
    upsertTaskState('ISSUE-1', {
      execution: { status: 'in_progress', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('ISSUE-2', {
      dependencyIssueIds: ['ISSUE-1'],
      execution: { status: 'blocked', retryCount: 0 },
      linearState: 'Backlog',
      updatedAt: new Date().toISOString(),
    });

    const blocked = getTaskReadiness({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(['ISSUE-1']);

    markTaskDone('ISSUE-1');
    const released = releaseDependentTasks('ISSUE-1');
    expect(released).toHaveLength(1);
    expect(released[0].issueId).toBe('ISSUE-2');
    expect(released[0].execution.status).toBe('todo');
    expect(released[0].linearState).toBe('Todo');
  });

  it('completes decomposed parent only after all child issues are done', () => {
    upsertTaskState('PARENT-1', {
      childIssueIds: ['CHILD-1', 'CHILD-2'],
      execution: { status: 'decomposed', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-1', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'done', retryCount: 0 },
      linearState: 'Done',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-2', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'todo', retryCount: 0 },
      linearState: 'Todo',
      updatedAt: new Date().toISOString(),
    });

    expect(completeParentIfChildrenDone('CHILD-1')).toBeNull();

    markTaskDone('CHILD-2');
    const parent = completeParentIfChildrenDone('CHILD-2');
    expect(parent?.issueId).toBe('PARENT-1');
    expect(parent?.execution.status).toBe('done');
    expect(parent?.linearState).toBe('Done');
  });

  it('hydrates canonical state from the latest Linear sync comment', () => {
    const older = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Backlog',
        execution: { status: 'blocked', retryCount: 0 },
      }),
      'Task blocked'
    );

    const latest = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Done',
        execution: { status: 'done', retryCount: 0 },
      }),
      'Task completed'
    );

    const hydrated = hydrateTaskStateFromComments('ISSUE-9', [
      { body: older, createdAt: '2026-03-18T00:00:00.000Z' },
      { body: latest, createdAt: '2026-03-18T01:00:00.000Z' },
    ]);

    expect(hydrated?.execution.status).toBe('done');
    expect(hydrated?.linearState).toBe('Done');
  });
});
