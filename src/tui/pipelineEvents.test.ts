import { describe, it, expect } from 'vitest';
import { reducePipelineEvent, initialPipelineState, MAX_STAGES, MAX_LOGS } from './pipelineEvents.js';
import type { HubEvent } from '../core/eventHub.js';

const stage = (over: Record<string, unknown> = {}): HubEvent => ({
  type: 'pipeline:stage',
  data: { taskId: 't1', stage: 'worker', status: 'start', ...over },
}) as HubEvent;
const log = (line: string): HubEvent => ({ type: 'log', data: { taskId: 't1', stage: 'worker', line } });

describe('reducePipelineEvent (EPIC INT-1813 S5)', () => {
  it('appends pipeline:stage entries with their fields', () => {
    let s = initialPipelineState;
    s = reducePipelineEvent(s, stage({ status: 'start' }));
    s = reducePipelineEvent(s, stage({
      status: 'complete',
      model: 'gpt',
      durationMs: 3000,
      decision: 'approve',
      repository: 'OpenSwarm',
      projectPath: '/repo/worktree/INT-2367',
      worktree: 'INT-2367',
      branch: 'swarm/INT-2367-pipeline-tree',
      issueIdentifier: 'INT-2367',
      title: 'Pipeline tree',
    }));
    expect(s.stages).toHaveLength(2);
    expect(s.stages[1]).toMatchObject({
      status: 'complete',
      model: 'gpt',
      decision: 'approve',
      repository: 'OpenSwarm',
      worktree: 'INT-2367',
      branch: 'swarm/INT-2367-pipeline-tree',
      issueIdentifier: 'INT-2367',
      title: 'Pipeline tree',
    });
  });

  it('appends log lines with a stage prefix', () => {
    const s = reducePipelineEvent(initialPipelineState, log('hello'));
    expect(s.logs).toEqual(['[worker] hello']);
  });

  it('ignores unrelated events (returns the same state)', () => {
    const s = reducePipelineEvent(initialPipelineState, { type: 'heartbeat' } as HubEvent);
    expect(s).toBe(initialPipelineState);
  });

  it('caps stages and logs at their maxima', () => {
    let s = initialPipelineState;
    for (let i = 0; i < MAX_STAGES + 10; i++) s = reducePipelineEvent(s, stage());
    expect(s.stages).toHaveLength(MAX_STAGES);

    let t = initialPipelineState;
    for (let i = 0; i < MAX_LOGS + 10; i++) t = reducePipelineEvent(t, log(`l${i}`));
    expect(t.logs).toHaveLength(MAX_LOGS);
    expect(t.logs[t.logs.length - 1]).toBe(`[worker] l${MAX_LOGS + 9}`);
  });
});
