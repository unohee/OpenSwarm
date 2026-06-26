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

/** Collapse newlines/whitespace runs to single spaces so a note stays one line. Pure. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate to width (with an ellipsis) so the spinner never wraps. Pure. */
export function truncateLine(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}…`;
}

/** One progress line: `⠙ reviewing… 3s · 🔧 read_file`. Pure. */
export function formatProgress(tick: number, elapsedSec: number, last?: string, width?: number): string {
  const base = `${spinnerFrame(tick)} reviewing… ${elapsedSec}s`;
  const line = last ? `${base} · ${last}` : base;
  return width ? truncateLine(line, width) : line;
}

export interface ReviewProgressDeps {
  write?: (s: string) => void;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  intervalMs?: number;
  /** Terminal width to truncate the line to (default stdout.columns ?? 80). */
  columns?: number;
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
  const columns = deps.columns ?? process.stdout.columns ?? 80;

  const start = now();
  let tick = 0;
  let last: string | undefined;

  const render = () => {
    const elapsedSec = Math.max(0, Math.floor((now() - start) / 1000));
    // Single line, truncated to width — a multi-line note must never stack. (INT-1966)
    write(`${CLEAR_LINE}${formatProgress(tick, elapsedSec, last, columns)}`);
    tick += 1;
  };

  render(); // immediate first frame
  const handle = setIntervalFn(render, intervalMs);

  return {
    note: (line: string) => {
      last = oneLine(line) || last;
    },
    stop: () => {
      clearIntervalFn(handle);
      write(CLEAR_LINE);
    },
  };
}
