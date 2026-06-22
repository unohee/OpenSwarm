import { describe, expect, it } from 'vitest';
import { isActionableLinearState } from './decisionEngine.js';

// INT-1809 R5: Backlog is "parked", not a work queue. Only Todo/In Progress/
// In Review are actionable, so moving an issue to Backlog stops the daemon.
describe('isActionableLinearState (R5)', () => {
  it('treats Todo / In Progress / In Review as actionable', () => {
    expect(isActionableLinearState('Todo')).toBe(true);
    expect(isActionableLinearState('In Progress')).toBe(true);
    expect(isActionableLinearState('In Review')).toBe(true);
  });

  it('parks Backlog by default', () => {
    expect(isActionableLinearState('Backlog')).toBe(false);
  });

  it('opts Backlog back in when includeBacklog is set', () => {
    expect(isActionableLinearState('Backlog', true)).toBe(true);
  });

  it('never acts on terminal states, even with includeBacklog', () => {
    expect(isActionableLinearState('Done')).toBe(false);
    expect(isActionableLinearState('Canceled')).toBe(false);
    expect(isActionableLinearState('Cancelled')).toBe(false);
    expect(isActionableLinearState('Done', true)).toBe(false);
  });

  it('does not gate unknown/undefined states (conservative)', () => {
    expect(isActionableLinearState(undefined)).toBe(true);
    expect(isActionableLinearState('Unknown')).toBe(true);
  });
});
