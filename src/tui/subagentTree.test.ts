import { describe, it, expect } from 'vitest';
import { buildSubagentTree } from './subagentTree.js';
import type { StageEntry } from './pipelineEvents.js';

const s = (taskId: string, stage: string, status: StageEntry['status']): StageEntry => ({ taskId, stage, status });

describe('buildSubagentTree (EPIC INT-1813 S7)', () => {
  it('groups stages by task into nodes', () => {
    const tree = buildSubagentTree([
      s('t1', 'worker', 'start'),
      s('t2', 'worker', 'start'),
      s('t1', 'reviewer', 'complete'),
    ]);
    expect(tree).toHaveLength(2);
    const t1 = tree.find((n) => n.taskId === 't1')!;
    expect(t1.stages.map((x) => x.stage)).toEqual(['worker', 'reviewer']);
  });

  it('rolls up status: fail dominates, all-complete completes, else running', () => {
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'fail')])[0].status).toBe('fail');
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'complete')])[0].status).toBe('complete');
    expect(buildSubagentTree([s('t', 'a', 'complete'), s('t', 'b', 'start')])[0].status).toBe('start');
  });

  it('returns an empty tree for no stages', () => {
    expect(buildSubagentTree([])).toEqual([]);
  });
});
