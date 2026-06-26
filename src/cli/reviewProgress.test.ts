import { describe, it, expect, vi } from 'vitest';
import { spinnerFrame, formatProgress, startReviewProgress } from './reviewProgress.js';

describe('spinnerFrame / formatProgress (INT-1963)', () => {
  it('cycles spinner frames and is safe for any tick', () => {
    expect(spinnerFrame(0)).toBe('⠋');
    expect(spinnerFrame(10)).toBe(spinnerFrame(0)); // wraps
    expect(typeof spinnerFrame(-1)).toBe('string');
  });

  it('formats elapsed seconds and an optional activity note', () => {
    expect(formatProgress(0, 3)).toBe('⠋ reviewing… 3s');
    expect(formatProgress(0, 5, '🔧 read_file')).toBe('⠋ reviewing… 5s · 🔧 read_file');
  });
});

describe('startReviewProgress (INT-1963)', () => {
  it('renders an immediate frame, ticks on the interval, and clears on stop', () => {
    const writes: string[] = [];
    let t = 0;
    let intervalFn: (() => void) | null = null;
    const cleared = vi.fn();
    const p = startReviewProgress({
      write: (s) => writes.push(s),
      now: () => t,
      setIntervalFn: (fn) => {
        intervalFn = fn as () => void;
        return 1 as never;
      },
      clearIntervalFn: cleared,
    });

    expect(writes.length).toBe(1); // immediate first frame
    expect(writes[0]).toContain('reviewing… 0s');

    p.note('🔧 read_file: a.ts');
    t = 4000;
    intervalFn!(); // next tick
    expect(writes.at(-1)).toContain('reviewing… 4s');
    expect(writes.at(-1)).toContain('🔧 read_file: a.ts');

    p.stop();
    expect(cleared).toHaveBeenCalled();
    expect(writes.at(-1)).toContain('\x1b[2K'); // clears the line
  });
});
