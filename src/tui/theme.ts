// ============================================
// OpenSwarm - TUI theme (INT-1943)
// Single source of colors + glyphs for the Ink cockpit, so the chat-first
// redesign stays visually consistent.
// ============================================

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

export const ICON = {
  user: '▸',
  assistant: '◆',
  system: '•',
  tool: '⦿',
  ok: '✓',
  fail: '✗',
  running: '◐',
  prompt: '›',
  git: '⎇',
} as const;

/** Gradient stops for the OpenSwarm wordmark (ink-gradient `colors`). */
export const LOGO_GRADIENT = ['#22d3ee', '#3b82f6', '#a855f7'];
