// ============================================
// OpenSwarm - review progress indicator (INT-1963)
// ============================================
//
// A live "still working" heartbeat for any multi-second CLI agent run (reviewer
// AND worker), so it doesn't look frozen. The formatter is pure (unit-tested);
// the runtime owns a timer + stderr writes (injectable for tests). The spinner
// is single-sourced from support/glyphs so the CLI heartbeat matches the TUI
// boards. (INT-2260)

export { spinnerFrame } from '../support/glyphs.js';
import { spinnerFrame } from '../support/glyphs.js';

/** Collapse newlines/whitespace runs to single spaces so a note stays one line. Pure. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Terminal display width of a code point: East-Asian wide / fullwidth characters
 * (Hangul, CJK, kana, fullwidth forms) and most emoji occupy 2 columns. (INT-1966)
 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string in terminal columns (wide chars count as 2). Pure. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Truncate to a terminal COLUMN budget (not code-unit length) with an ellipsis,
 * so a line of wide chars never exceeds the width and wraps. (INT-1966)
 */
export function truncateLine(s: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break; // reserve one column for the ellipsis
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** One progress line: `⣾ reviewing… 3s · 🔧 read_file`. Pure. (label defaults to `reviewing…`) */
export function formatProgress(tick: number, elapsedSec: number, last?: string, width?: number, label = 'reviewing…'): string {
  const base = `${spinnerFrame(tick)} ${label} ${elapsedSec}s`;
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
 * `label` is the verb shown next to the spinner (`reviewing…`, `worker…`), so
 * the same heartbeat serves every CLI agent stage. Returns handles to update the
 * activity note and to stop. (INT-1963, INT-2260)
 */
export function startProgressHeartbeat(label: string, deps: ReviewProgressDeps = {}): ReviewProgress {
  const write = deps.write ?? ((s: string) => process.stderr.write(s));
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const intervalMs = deps.intervalMs ?? 200;
  const columns = deps.columns ?? process.stdout.columns ?? 80;
  // Reserve the last column: writing into it auto-wraps on most terminals, which
  // re-introduces the multi-row stacking we're trying to avoid. (INT-1966)
  const maxCols = Math.max(10, columns - 1);

  const start = now();
  let tick = 0;
  let last: string | undefined;

  const render = () => {
    const elapsedSec = Math.max(0, Math.floor((now() - start) / 1000));
    // Single line, truncated to display width — a wide-char note must never wrap/stack. (INT-1966)
    write(`${CLEAR_LINE}${formatProgress(tick, elapsedSec, last, maxCols, label)}`);
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

/** The reviewer's heartbeat — `startProgressHeartbeat` with the `reviewing…` label. */
export function startReviewProgress(deps: ReviewProgressDeps = {}): ReviewProgress {
  return startProgressHeartbeat('reviewing…', deps);
}
