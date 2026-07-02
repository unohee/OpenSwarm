import { describe, it, expect } from 'vitest';
import { buildSubagentTree } from './subagentTree.js';
import type { StageEntry } from './pipelineEvents.js';

const s = (taskId: string, stage: string, status: StageEntry['status'], over: Partial<StageEntry> = {}): StageEntry => ({
  taskId,
  stage,
  status,
  ...over,
});

describe('buildSubagentTree (EPIC INT-1813 S7)', () => {
  it('groups stages by repository and worktree into role nodes', () => {
    const tree = buildSubagentTree([
      s('t1', 'worker', 'start', { repository: 'OpenSwarm', worktree: 'INT-1', branch: 'swarm/INT-1' }),
      s('t2', 'worker', 'start', { repository: 'OpenSwarm', worktree: 'INT-2', branch: 'swarm/INT-2' }),
      s('t1', 'reviewer', 'complete', { repository: 'OpenSwarm', worktree: 'INT-1', branch: 'swarm/INT-1' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].repository).toBe('OpenSwarm');
    expect(tree[0].worktrees).toHaveLength(2);
    const t1 = tree[0].worktrees.find((n) => n.taskId === 't1')!;
    expect(t1.branch).toBe('swarm/INT-1');
    expect(t1.roles.map((x) => x.role)).toEqual(['Worker', 'Reviewer']);
  });

  it('rolls up status: fail dominates, all-complete completes, else running', () => {
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'fail')])[0].worktrees[0].status).toBe('fail');
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'complete')])[0].worktrees[0].status).toBe('complete');
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'start')])[0].worktrees[0].status).toBe('start');
  });

  it('rolls up from the latest status for each stage', () => {
    const tree = buildSubagentTree([
      s('t', 'worker', 'start'),
      s('t', 'worker', 'complete'),
      s('t', 'reviewer', 'start'),
      s('t', 'reviewer', 'complete'),
    ]);

    expect(tree[0].worktrees[0].status).toBe('complete');
    expect(tree[0].worktrees[0].roles.map((x) => `${x.role}:${x.status}`)).toEqual(['Worker:complete', 'Reviewer:complete']);
  });

  it('infers repository and worktree from projectPath when event metadata is sparse', () => {
    const tree = buildSubagentTree([
      s('INT-2367-task', 'draft', 'complete', {
        projectPath: '/Users/u/dev/OpenSwarm/worktree/INT-2367',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      }),
    ]);

    expect(tree[0].repository).toBe('OpenSwarm');
    expect(tree[0].worktrees[0]).toMatchObject({
      worktree: 'INT-2367',
      issueIdentifier: 'INT-2367',
      title: 'Pipeline tab tree',
      currentStage: 'Drafter',
    });
  });

  it('keeps draft and worktree events for the same issue in one node', () => {
    const tree = buildSubagentTree([
      s('INT-2367', 'draft', 'complete', {
        repository: 'OpenSwarm',
        projectPath: '/Users/u/dev/OpenSwarm',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      }),
      s('linear-uuid', 'worker', 'start', {
        repository: 'OpenSwarm',
        projectPath: '/Users/u/dev/OpenSwarm/worktree/linear-uuid',
        worktree: 'linear-uuid',
        branch: 'swarm/INT-2367-pipeline-tree',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      }),
      s('linear-uuid', 'reviewer', 'complete', {
        repository: 'OpenSwarm',
        projectPath: '/Users/u/dev/OpenSwarm/worktree/linear-uuid',
        worktree: 'linear-uuid',
        branch: 'swarm/INT-2367-pipeline-tree',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].worktrees).toHaveLength(1);
    expect(tree[0].worktrees[0].roles.map((role) => role.role)).toEqual(['Drafter', 'Worker', 'Reviewer']);
    expect(tree[0].worktrees[0]).toMatchObject({
      issueIdentifier: 'INT-2367',
      branch: 'swarm/INT-2367-pipeline-tree',
      worktree: 'linear-uuid',
    });
  });

  it('orders worktrees by their latest event for max display limits', () => {
    const tree = buildSubagentTree([
      s('INT-1', 'worker', 'start', { repository: 'OpenSwarm', issueIdentifier: 'INT-1' }),
      s('INT-2', 'worker', 'start', { repository: 'OpenSwarm', issueIdentifier: 'INT-2' }),
      s('INT-1', 'reviewer', 'complete', { repository: 'OpenSwarm', issueIdentifier: 'INT-1' }),
    ]);

    expect(tree[0].worktrees.map((node) => node.issueIdentifier)).toEqual(['INT-2', 'INT-1']);
  });

  it('returns an empty tree for no stages', () => {
    expect(buildSubagentTree([])).toEqual([]);
  });
});
