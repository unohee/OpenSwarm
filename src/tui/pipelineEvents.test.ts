import { describe, it, expect } from 'vitest';
import { classifyActivity, reducePipelineEvent, initialPipelineState, MAX_STAGES, MAX_LOGS } from './pipelineEvents.js';
import type { HubEvent } from '../core/eventHub.js';

const stage = (over: Record<string, unknown> = {}): HubEvent => ({
  type: 'pipeline:stage',
  data: { taskId: 't1', stage: 'worker', status: 'start', ...over },
}) as HubEvent;
const log = (line: string): HubEvent => ({ type: 'log', data: { taskId: 't1', stage: 'worker', line } });
const processSpawn = (over: Record<string, unknown> = {}): HubEvent => ({
  type: 'process:spawn',
  data: { pid: 1, taskId: 't1', stage: 'worker', projectPath: '/repo', ...over },
}) as HubEvent;
const processExit = (over: Record<string, unknown> = {}): HubEvent => ({
  type: 'process:exit',
  data: { pid: 1, taskId: 't1', stage: 'worker', exitCode: 0, signal: null, durationMs: 1000, ...over },
}) as HubEvent;

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

  it('updates the running stage with compact activity from logs', () => {
    let s = reducePipelineEvent(initialPipelineState, stage({ status: 'start' }));
    s = reducePipelineEvent(s, log('🔧 read_file src/app.ts'));
    expect(s.stages[0]).toMatchObject({ activity: 'tool: read_file' });

    s = reducePipelineEvent(s, log('reasoning about next patch'));
    expect(s.stages[0]).toMatchObject({ activity: 'thinking' });
  });

  it('clears process waiting activity only for the matching task and stage', () => {
    let s = initialPipelineState;
    s = reducePipelineEvent(s, stage({ taskId: 't1', stage: 'worker', status: 'start' }));
    s = reducePipelineEvent(s, stage({ taskId: 't2', stage: 'worker', status: 'start' }));
    s = reducePipelineEvent(s, processSpawn({ taskId: 't1', stage: 'worker' }));
    s = reducePipelineEvent(s, processSpawn({ taskId: 't2', stage: 'worker' }));
    s = reducePipelineEvent(s, processExit({ taskId: 't1', stage: 'worker' }));

    expect(s.stages.find((entry) => entry.taskId === 't1')?.activity).toBeUndefined();
    expect(s.stages.find((entry) => entry.taskId === 't2')?.activity).toBe('waiting');
  });

  it('shows rate-limit activity only when sourced from real event data', () => {
    let s = reducePipelineEvent(initialPipelineState, stage({ status: 'start' }));
    s = reducePipelineEvent(s, stage({ status: 'fail', error: '429 rate limit exceeded', rateLimitResetsAt: 1770000000000 }));
    expect(s.stages[1]).toMatchObject({ activity: 'rate-limited', rateLimitResetsAt: 1770000000000 });

    const clean = reducePipelineEvent(initialPipelineState, stage({ status: 'complete' }));
    expect(clean.stages[0].rateLimitResetsAt).toBeUndefined();
  });

  it('classifies supported activity without inventing unknown quota values', () => {
    expect(classifyActivity('tool: apply_patch')).toBe('tool: apply_patch');
    expect(classifyActivity('Checking repository state')).toBe('thinking');
    expect(classifyActivity('quota will reset soon')).toBe('rate-limited');
    expect(classifyActivity('ordinary log line')).toBeUndefined();
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
