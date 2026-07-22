import { describe, expect, it } from 'vitest';
import { aggregateFailureCauses, classifyFailureCause, type PipelineHistoryEntry } from './runnerState.js';

describe('pipeline history failure causes (INT-2659)', () => {
  it.each([
    ['reviewer-reject', { success: false, finalStatus: 'rejected', reviewerDecision: 'reject' }],
    ['infra', { success: false, finalStatus: 'infra_error' }],
    ['rate-limit', { success: false, finalStatus: 'rate_limited' }],
    ['no-changes', { success: false, finalStatus: 'failed', workerFilesChanged: 0 }],
    ['gate-fail', { success: false, finalStatus: 'failed', workerFilesChanged: 1, failureSignal: 'gate-fail' }],
    ['timeout', { success: false, finalStatus: 'infra_error', failureSignal: 'timeout' }],
    ['stuck', { success: false, finalStatus: 'failed', failureSignal: 'stuck' }],
    ['cancelled', { success: false, finalStatus: 'cancelled' }],
  ] as const)('classifies %s from structural fields', (expected, signals) => {
    expect(classifyFailureCause(signals)).toBe(expected);
  });

  it('does not attach a cause to successful or decomposed runs', () => {
    expect(classifyFailureCause({ success: true, finalStatus: 'approved' })).toBeUndefined();
    expect(classifyFailureCause({ success: false, finalStatus: 'decomposed' })).toBeUndefined();
  });

  it('aggregates new entries while accepting legacy entries without failureCause', () => {
    const entry = (failureCause?: PipelineHistoryEntry['failureCause']) => ({
      sessionId: crypto.randomUUID(), taskTitle: 'task', success: false, finalStatus: 'failed',
      iterations: 1, totalDuration: 1, stages: [], completedAt: new Date().toISOString(), failureCause,
    }) satisfies PipelineHistoryEntry;
    const counts = aggregateFailureCauses([entry('infra'), entry('infra'), entry('gate-fail'), entry()]);
    expect(counts).toMatchObject({ infra: 2, 'gate-fail': 1, cancelled: 0 });
  });
});
