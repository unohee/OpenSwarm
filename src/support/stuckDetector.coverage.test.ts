// Coverage-focused tests for stuckDetector.ts, complementing stuckDetector.test.ts.
// Targets: the 20-entry history cap, the early "too little history" guards in
// check()/detectErrorLoop()/detectOutputRepeat(), the previously-untested
// detectRevisionLoop() and detectMonologue() detectors (both branches each),
// the "not stuck" fallthroughs of detectErrorLoop()/detectOutputRepeat(), and
// the reset()/getHistory()/createStuckDetector() utility surface.
import { describe, expect, it } from 'vitest';
import { StuckDetector, createStuckDetector, normalizeErrorForLoop, type HistoryEntry } from './stuckDetector.js';

let ts = 0;

function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    stage: 'worker',
    success: true,
    timestamp: ++ts,
    ...patch,
  };
}

describe('StuckDetector - history cap', () => {
  it('keeps only the last 20 entries once the cap is exceeded', () => {
    const detector = new StuckDetector();

    for (let i = 0; i < 25; i++) {
      detector.addEntry(entry({ stage: `stage-${i}`, output: `out-${i}` }));
    }

    const history = detector.getHistory();
    expect(history).toHaveLength(20);
    // The oldest 5 entries (stage-0..stage-4) should have been dropped.
    expect(history[0].stage).toBe('stage-5');
    expect(history.at(-1)?.stage).toBe('stage-24');
  });
});

describe('StuckDetector - check() early guard', () => {
  it('reports not stuck with fewer than 2 history entries', () => {
    const detector = new StuckDetector();
    expect(detector.check()).toEqual({ isStuck: false });

    detector.addEntry(entry({}));
    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('StuckDetector - detectErrorLoop fallthroughs', () => {
  it('is not stuck when history has fewer entries than sameErrorRepeat', () => {
    // 2 entries total (passes check()'s >=2 guard) but threshold is 3, so
    // detectErrorLoop's own length guard returns not-stuck.
    const detector = new StuckDetector({ sameErrorRepeat: 3 });
    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });

  it('is not stuck when the recent errors are genuinely different (not a loop)', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });
    detector.addEntry(entry({ success: false, error: 'cargo build failed: missing symbol foo' }));
    detector.addEntry(entry({ success: false, error: 'pytest failed: assertion error in test_bar' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('StuckDetector - detectRevisionLoop', () => {
  it('flags 4 consecutive REVISE decisions as stuck', () => {
    const detector = new StuckDetector({ revisionLoop: 4 });
    for (let i = 0; i < 4; i++) {
      detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISE' }));
    }

    const result = detector.check();
    expect(result.isStuck).toBe(true);
    expect(result.reason).toContain('Reviewer requested revision 4 times consecutively');
  });

  it('recognizes REVISION_NEEDED and "REVISION NEEDED" decision spellings', () => {
    const detector = new StuckDetector({ revisionLoop: 3 });
    detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISION_NEEDED' }));
    detector.addEntry(entry({ stage: 'reviewer', decision: 'revision needed' }));
    detector.addEntry(entry({ stage: 'reviewer', decision: 'Revise' }));

    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('is not stuck when review decisions are mixed', () => {
    const detector = new StuckDetector({ revisionLoop: 3 });
    detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISE' }));
    detector.addEntry(entry({ stage: 'reviewer', decision: 'APPROVE' }));
    detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISE' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });

  it('only counts reviewer-stage entries that carry a decision', () => {
    const detector = new StuckDetector({ revisionLoop: 3 });
    // Non-reviewer stages and reviewer entries without a decision must not
    // count toward the revision-loop window.
    detector.addEntry(entry({ stage: 'worker', output: 'a' }));
    detector.addEntry(entry({ stage: 'reviewer' })); // no decision
    detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISE' }));
    detector.addEntry(entry({ stage: 'reviewer', decision: 'REVISE' }));

    // Only 2 qualifying reviewer+decision entries exist, below the threshold of 3.
    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('StuckDetector - detectOutputRepeat fallthrough', () => {
  it('is not stuck when the recent outputs differ', () => {
    const detector = new StuckDetector({ sameOutputRepeat: 3 });
    detector.addEntry(entry({ output: 'alpha' }));
    detector.addEntry(entry({ output: 'beta' }));
    detector.addEntry(entry({ output: 'gamma' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('StuckDetector - detectMonologue', () => {
  it('flags 6 consecutive same-stage entries as stuck', () => {
    const detector = new StuckDetector({ monologue: 6 });
    for (let i = 0; i < 6; i++) {
      // Vary output/stage-irrelevant fields so earlier detectors don't fire first.
      detector.addEntry(entry({ stage: 'worker', output: `distinct-output-${i}` }));
    }

    const result = detector.check();
    expect(result.isStuck).toBe(true);
    expect(result.reason).toContain('Stage "worker" executed 6 times without progression');
    expect(result.suggestion).toContain('Pipeline may be stuck');
  });

  it('is not stuck when the recent stages are mixed', () => {
    const detector = new StuckDetector({ monologue: 6 });
    const stages = ['worker', 'reviewer', 'worker', 'planner', 'worker', 'reviewer'];
    for (const stage of stages) {
      detector.addEntry(entry({ stage, output: `output-for-${stage}-${ts}` }));
    }

    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('StuckDetector - reset() and getHistory()', () => {
  it('reset() clears all history so check() reverts to the early guard', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });
    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));
    expect(detector.check()).toMatchObject({ isStuck: true });

    detector.reset();

    expect(detector.getHistory()).toEqual([]);
    expect(detector.check()).toEqual({ isStuck: false });
  });

  it('getHistory() returns a defensive copy, not a live reference', () => {
    const detector = new StuckDetector();
    detector.addEntry(entry({}));

    const history = detector.getHistory();
    history.push(entry({}));

    // Mutating the returned array must not affect the detector's internal state.
    expect(detector.getHistory()).toHaveLength(1);
  });
});

describe('normalizeErrorForLoop() - undefined input', () => {
  it('treats an undefined error as an empty string rather than throwing', () => {
    expect(normalizeErrorForLoop(undefined)).toBe('');
  });
});

describe('createStuckDetector()', () => {
  it('creates a working StuckDetector instance with default thresholds', () => {
    const detector = createStuckDetector();
    expect(detector).toBeInstanceOf(StuckDetector);

    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));
    // Default sameErrorRepeat is 2, so this should already be flagged as stuck.
    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('forwards custom thresholds', () => {
    const detector = createStuckDetector({ sameErrorRepeat: 5 });
    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));
    // With a threshold of 5, 2 repeats must not trip the error-loop detector.
    expect(detector.check()).toEqual({ isStuck: false });
  });
});
