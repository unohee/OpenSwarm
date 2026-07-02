import { describe, expect, it } from 'vitest';
import { StuckDetector, type HistoryEntry } from './stuckDetector.js';

let ts = 0;

function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    stage: 'worker',
    success: true,
    timestamp: ++ts,
    ...patch,
  };
}

describe('StuckDetector', () => {
  it('detects consecutive repeated errors', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });

    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));

    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('does not treat historical matching errors as consecutive after progress', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });

    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: true, output: 'made progress' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });

  it('detects consecutive repeated outputs', () => {
    const detector = new StuckDetector({ sameOutputRepeat: 3 });

    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));

    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('does not treat historical matching outputs as consecutive after a different event', () => {
    const detector = new StuckDetector({ sameOutputRepeat: 3 });

    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ stage: 'reviewer', success: true, decision: 'APPROVE' }));
    detector.addEntry(entry({ output: 'same output' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });
});
