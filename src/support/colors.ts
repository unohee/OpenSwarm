// ============================================
// OpenSwarm - Terminal color helpers (zero-dependency ANSI)
// ============================================
//
// Honors NO_COLOR and non-TTY output (pipes/CI) — colors are stripped so logs
// stay clean when redirected. Used by CLI commands (init, doctor, …).

import { GLYPH, type StatusKind } from './glyphs.js';

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  enabled: useColor,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  /** 24-bit truecolor foreground (for the banner gradient). */
  rgb:
    (r: number, g: number, b: number) =>
    (s: string): string =>
      useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s,
};

/** Console color per status kind — the plain-output twin of theme.STATUS. */
const STATUS_PAINT: Record<StatusKind, (s: string) => string> = {
  running: c.cyan,
  ok: c.green,
  warn: c.yellow,
  err: c.red,
  revise: c.magenta,
  info: c.blue,
};

/**
 * Console status helpers — the plain-output adapter over the shared glyph
 * vocabulary (support/glyphs GLYPH), mirroring the Ink <StatusIcon>. `status.ok(
 * 'saved')` → a green `✓ saved` (stripped under NO_COLOR / non-TTY). Use these
 * instead of hand-writing `console.log('✓ …')` so CLI output can't drift from
 * the TUI. (INT-2260)
 */
export const status = {
  /** Bare colored glyph (no trailing text), e.g. for inline use. */
  glyph: (kind: StatusKind): string => STATUS_PAINT[kind](GLYPH[kind]),
  /** `<glyph> <text>`, colored for the kind. */
  line: (kind: StatusKind, text: string): string => STATUS_PAINT[kind](`${GLYPH[kind]} ${text}`),
  ok: (text: string): string => STATUS_PAINT.ok(`${GLYPH.ok} ${text}`),
  err: (text: string): string => STATUS_PAINT.err(`${GLYPH.err} ${text}`),
  warn: (text: string): string => STATUS_PAINT.warn(`${GLYPH.warn} ${text}`),
  revise: (text: string): string => STATUS_PAINT.revise(`${GLYPH.revise} ${text}`),
  running: (text: string): string => STATUS_PAINT.running(`${GLYPH.running} ${text}`),
  info: (text: string): string => STATUS_PAINT.info(`${GLYPH.info} ${text}`),
};
