import { describe, it, expect } from 'vitest';
import { nextFailureState, MAX_CONSECUTIVE_FAILURES } from './scheduler.js';

describe('nextFailureState (INT-1958)', () => {
  it('resets the counter on success', () => {
    expect(nextFailureState(2, true)).toEqual({ consecutiveFailures: 0, autoPause: false });
  });

  it('increments on failure without pausing below the threshold', () => {
    expect(nextFailureState(0, false)).toEqual({ consecutiveFailures: 1, autoPause: false });
    expect(nextFailureState(1, false)).toEqual({ consecutiveFailures: 2, autoPause: false });
  });

  it('auto-pauses once the threshold is reached', () => {
    expect(nextFailureState(MAX_CONSECUTIVE_FAILURES - 1, false)).toEqual({
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      autoPause: true,
    });
  });

  it('honors a custom threshold', () => {
    expect(nextFailureState(0, false, 1)).toEqual({ consecutiveFailures: 1, autoPause: true });
  });
});
