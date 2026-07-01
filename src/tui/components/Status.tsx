// ============================================
// OpenSwarm - Shared Ink status primitives (INT-2260)
// ============================================
//
// The Ink adapter over the shared glyph vocabulary. Every board/tree/timeline
// renders in-progress and terminal status through <Spinner> and <StatusIcon>,
// so a "running / done / failed / revise" always looks the same and nothing is
// left static or off-theme. The plain-console twin lives in support/colors
// (`status`); both read the same GLYPH / theme.STATUS source.

import { Text } from 'ink';
import { useState, useEffect } from 'react';
import { theme, STATUS } from '../theme.js';
import { spinnerFrame } from '../../support/glyphs.js';
import type { StatusKind } from '../../support/glyphs.js';

/** A themed status glyph (◐ ✓ ✗ ⚠ ✎ •), colored per theme.STATUS. */
export function StatusIcon({ kind }: { kind: StatusKind }) {
  const s = STATUS[kind];
  return <Text color={s.color}>{s.icon}</Text>;
}

/**
 * A self-animating braille spinner — the one in-progress indicator. Drop it
 * anywhere a running row/line needs to show life; it owns its own timer so
 * callers don't each re-implement a tick.
 */
export function Spinner({ intervalMs = 120 }: { intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return <Text color={theme.accent}>{spinnerFrame(tick)}</Text>;
}
