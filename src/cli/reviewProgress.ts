// ============================================
// OpenSwarm - review progress indicator (INT-1963)
// ============================================
//
// A live "still working" heartbeat for `openswarm review`, so a multi-second
// reviewer run doesn't look frozen. The formatter is pure (unit-tested); the
// runtime owns a timer + stderr writes (injectable for tests).

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Braille spinner frame for a tick. Pure. */
export function spinnerFrame(tick: number): string {
  return FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length];
}

/** One progress line: `⠙ reviewing… 3s · 🔧 read_file`. Pure. */
export function formatProgress(tick: number, elapsedSec: number, last?: string): string {
  const base = `${spinnerFrame(tick)} reviewing… ${elapsedSec}s`;
  return last ? `${base} · ${last}` : base;
}

export interface ReviewProgressDeps {
  write?: (s: string) => void;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  intervalMs?: number;
}

export interface ReviewProgress {
  /** Update the trailing activity note (e.g. the latest tool line). */
  note: (line: string) => void;
  /** Stop the spinner and clear the line. */
  stop: () => void;
}

const CLEAR_LINE = '\r\x1b[2K';

/**
 * Start a spinner heartbeat that re-renders every intervalMs until stop().
 * Returns handles to update the activity note and to stop. (INT-1963)
 */
export function startReviewProgress(deps: ReviewProgressDeps = {}): ReviewProgress {
  const write = deps.write ?? ((s: string) => process.stderr.write(s));
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const intervalMs = deps.intervalMs ?? 200;

  const start = now();
  let tick = 0;
  let last: string | undefined;

  const render = () => {
    const elapsedSec = Math.max(0, Math.floor((now() - start) / 1000));
    write(`${CLEAR_LINE}${formatProgress(tick, elapsedSec, last)}`);
    tick += 1;
  };

  render(); // immediate first frame
  const handle = setIntervalFn(render, intervalMs);

  return {
    note: (line: string) => {
      last = line.trim() || last;
    },
    stop: () => {
      clearIntervalFn(handle);
      write(CLEAR_LINE);
    },
  };
}
