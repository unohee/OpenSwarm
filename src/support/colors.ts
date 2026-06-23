// ============================================
// OpenSwarm - Terminal color helpers (zero-dependency ANSI)
// ============================================
//
// Honors NO_COLOR and non-TTY output (pipes/CI) — colors are stripped so logs
// stay clean when redirected. Used by CLI commands (init, doctor, …).

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
