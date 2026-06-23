// ============================================
// OpenSwarm - ASCII banner (figlet "Standard" + honey gradient 🐝)
// ============================================

import { c } from './colors.js';

// figlet "Standard" of "OpenSwarm" (exact, JS-escaped).
const LOGO_LINES = [
  '   ___                   ____                              ',
  '  / _ \\ _ __   ___ _ __ / ___|_      ____ _ _ __ _ __ ___  ',
  " | | | | '_ \\ / _ \\ '_ \\\\___ \\ \\ /\\ / / _` | '__| '_ ` _ \\ ",
  ' | |_| | |_) |  __/ | | |___) \\ V  V / (_| | |  | | | | | |',
  '  \\___/| .__/ \\___|_| |_|____/ \\_/\\_/ \\__,_|_|  |_| |_| |_|',
  '       |_|                                                 ',
];

// Honey/amber gradient, top→bottom (bee theme).
const GRADIENT: Array<[number, number, number]> = [
  [255, 213, 79],
  [255, 193, 7],
  [255, 167, 38],
  [251, 140, 0],
  [245, 124, 0],
  [230, 81, 0],
];

/**
 * Render the OpenSwarm banner. Gradient-colored logo + subtitle. Colors are
 * auto-stripped on non-TTY / NO_COLOR (see colors.ts), so this is safe to print
 * unconditionally.
 */
export function banner(subtitle = 'autonomous agent orchestrator'): string {
  const logo = LOGO_LINES.map((ln, i) => c.rgb(...GRADIENT[i % GRADIENT.length])(ln)).join('\n');
  return `\n${logo}\n   ${c.yellow('🐝')} ${c.bold(c.cyan(subtitle))}\n`;
}
