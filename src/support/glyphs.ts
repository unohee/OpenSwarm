// ============================================
// OpenSwarm - Status glyph + spinner vocabulary (INT-2260)
// ============================================
//
// The SINGLE source of truth for status glyphs and the braille spinner, shared
// by both render targets: the Ink TUI (via theme.ts STATUS + <StatusIcon>/
// <Spinner>) and plain console output (via support/colors.ts `status`). Every
// view renders through one of those two adapters, so no component hand-rolls its
// own glyph / frame set again — that drift is what left some views without a
// spinner or with the wrong icon. Context-free on purpose: no Ink, no ANSI here.

/** Semantic status kinds shared across every progress/verdict surface. */
export type StatusKind = 'running' | 'ok' | 'warn' | 'err' | 'revise' | 'info';

/** The one glyph vocabulary. Views reference these — never a literal. */
export const GLYPH: Record<StatusKind, string> = {
  running: '◐',
  ok: '✓',
  warn: '⚠',
  err: '✗',
  revise: '✎',
  info: '•',
};

/** The one braille spinner. Both the CLI heartbeat and the Ink boards use it. */
export const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const;

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** Braille spinner glyph for the given tick. Pure. */
export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[mod(tick, SPINNER_FRAMES.length)];
}
