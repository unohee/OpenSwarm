import { describe, it, expect, vi } from 'vitest';
import { spinnerFrame, formatProgress, startReviewProgress, oneLine, truncateLine, displayWidth } from './reviewProgress.js';

describe('spinnerFrame / formatProgress (INT-1963)', () => {
  it('cycles spinner frames and is safe for any tick', () => {
    // Single-sourced braille spinner from support/glyphs (8 frames). (INT-2260)
    expect(spinnerFrame(0)).toBe('⣾');
    expect(spinnerFrame(8)).toBe(spinnerFrame(0)); // wraps at frame count (8)
    expect(typeof spinnerFrame(-1)).toBe('string');
  });

  it('formats elapsed seconds and an optional activity note', () => {
    expect(formatProgress(0, 3)).toBe('⣾ reviewing… 3s');
    expect(formatProgress(0, 5, '🔧 read_file')).toBe('⣾ reviewing… 5s · 🔧 read_file');
  });
});

describe('oneLine / truncateLine (INT-1966)', () => {
  it('collapses newlines and whitespace runs to one line', () => {
    expect(oneLine('first line\nsecond   line\t\nthird')).toBe('first line second line third');
    expect(oneLine('  trim  ')).toBe('trim');
  });
  it('truncates with an ellipsis and is a no-op under width', () => {
    expect(truncateLine('hello world', 8)).toBe('hello w…');
    expect(truncateLine('short', 80)).toBe('short');
  });
  it('counts wide (CJK/Hangul/emoji) chars as 2 columns (INT-1966)', () => {
    expect(displayWidth('가')).toBe(2);
    expect(displayWidth('ab')).toBe(2);
    expect(displayWidth('가a')).toBe(3);
    expect(displayWidth('😀')).toBe(2);
  });
  it('truncates Korean by display width, not code-unit length (INT-1966)', () => {
    const out = truncateLine('가'.repeat(30), 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10); // would have been ~30 cols if length-based
    expect(out.endsWith('…')).toBe(true);
  });
  it('formatProgress truncates ascii to a column budget', () => {
    expect(displayWidth(formatProgress(0, 3, 'a'.repeat(100), 20))).toBeLessThanOrEqual(20);
  });
});

describe('startReviewProgress multi-line note (INT-1966)', () => {
  it('renders a multi-line note as a single truncated line (no stacking)', () => {
    const writes: string[] = [];
    let intervalFn: (() => void) | null = null;
    const p = startReviewProgress({
      write: (s) => writes.push(s),
      now: () => 0,
      setIntervalFn: (fn) => {
        intervalFn = fn as () => void;
        return 1 as never;
      },
      clearIntervalFn: () => {},
      columns: 40,
    });
    // Korean (wide) multi-line note — the real failing case: width must stay ≤ columns.
    p.note('작업 중입니다.\n변경된 3개 파일 (`data/bench_external/odysseybench/tasks/...`)\n점수 확인');
    intervalFn!();
    const content = writes.at(-1)!.replace('\r\x1b[2K', '');
    expect(content).not.toContain('\n'); // single line
    expect(displayWidth(content)).toBeLessThanOrEqual(40); // never exceeds terminal width → no wrap
    p.stop();
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
