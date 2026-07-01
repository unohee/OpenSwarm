// ============================================
// OpenSwarm - Loading flavor (INT-1813 follow-up)
// The Warhammer-40k loading lines + braille spinner from the blessed TUI,
// recovered for the Ink cockpit. Pure data + frame/message derivation so the
// animation logic is unit-testable; WorkingIndicator wires the timer.
// ============================================

export const LOADING_MESSAGES = [
  'Initializing cogitator arrays',
  'Querying data-vault archives',
  'Accessing servitor protocols',
  'Compiling neural responses',
  'Interfacing with the Noosphere',
  'Scanning data-streams',
  'Calibrating logic engines',
  'Decoding transmission packets',
  'Loading archive databases',
  'Synchronizing machine protocols',
  'Analyzing pattern matrices',
  'Establishing neural link',
  'Processing data-core output',
  'Running diagnostics sequence',
  'Activating response circuits',
] as const;

// Spinner is single-sourced from support/glyphs (INT-2260); re-exported here for
// the existing TUI importers (AuditBoard, WorkingIndicator).
export { SPINNER_FRAMES, spinnerFrame } from '../support/glyphs.js';

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Loading line for a given tick. The message advances once per `periodMs`
 * (spinner ticks every `tickMs`); `base` offsets the starting line so each run
 * opens on a different message.
 */
export function loadingMessage(tick: number, base = 0, periodMs = 2500, tickMs = 120): string {
  const idx = base + Math.floor((tick * tickMs) / periodMs);
  return LOADING_MESSAGES[mod(idx, LOADING_MESSAGES.length)];
}
