// ============================================
// OpenSwarm - TUI theme (INT-1943, INT-2260)
// Single source of colors + glyphs for the Ink cockpit, so the chat-first
// redesign stays visually consistent. Status glyphs + the spinner come from the
// context-free `support/glyphs` so plain console output (support/colors `status`)
// shares the exact same vocabulary — no view redeclares its own icons.
// ============================================

import { GLYPH, type StatusKind } from '../support/glyphs.js';

export const theme = {
  accent: 'cyan',
  accentAlt: 'magentaBright',
  user: 'cyan',
  assistant: 'white',
  system: 'yellow',
  dim: 'gray',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  running: 'yellow',
  info: 'blue',
  border: 'gray',
  borderActive: 'cyan',
} as const;

/** Non-status decoration glyphs + the shared status vocabulary (from GLYPH). */
export const ICON = {
  user: '▸',
  assistant: '◆',
  system: '•',
  tool: '⦿',
  prompt: '›',
  git: '⎇',
  // Status glyphs — single-sourced from support/glyphs. `fail` kept as the
  // established alias for the error glyph.
  ok: GLYPH.ok,
  fail: GLYPH.err,
  running: GLYPH.running,
  warn: GLYPH.warn,
  revise: GLYPH.revise,
  info: GLYPH.info,
} as const;

/**
 * Status semantic → { glyph, Ink color token }. The one map the Ink status
 * primitives (<StatusIcon>) read, so every board/tree/timeline colors and
 * glyphs a "running / done / failed / revise" the same way.
 */
export const STATUS: Record<StatusKind, { icon: string; color: string }> = {
  running: { icon: GLYPH.running, color: theme.running },
  ok: { icon: GLYPH.ok, color: theme.ok },
  warn: { icon: GLYPH.warn, color: theme.warn },
  err: { icon: GLYPH.err, color: theme.err },
  revise: { icon: GLYPH.revise, color: theme.accentAlt },
  info: { icon: GLYPH.info, color: theme.info },
};

/** Gradient stops for the OpenSwarm wordmark (ink-gradient `colors`). */
export const LOGO_GRADIENT = ['#22d3ee', '#3b82f6', '#a855f7'];
