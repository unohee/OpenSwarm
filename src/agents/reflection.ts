// ============================================
// OpenSwarm - Self-Repair Reflection
// Bad-edit guard + bounded reflection loop
// ============================================
//
// claude -p (and most CLI coding agents) lack the native sub-agent / structured
// self-repair that the first-party Claude harness has. When an edit breaks the
// build, the agent often reports success anyway. This module gives the pipeline a
// lightweight self-repair loop, modeled on two proven techniques:
//
//   - SWE-agent "bad-edit guard": an edit that fails lint is treated as invalid;
//     the concrete lint error is fed straight back so the next attempt fixes it
//     (ablation: removing it dropped resolve rate 18% → 15%).
//   - Aider "reflection": lint/test errors from the previous attempt are preserved
//     into the next prompt, up to a bounded reflection count (default 3).
//
// The worker here is an autonomous CLI process, so we cannot intercept a single
// tool-edit to discard it the way SWE-agent does. The equivalent is: lint the
// changed files after the worker finishes, and on failure drive a bounded retry
// with the exact error preserved — objective errors survive even a fresh-context
// reset, because unlike a reviewer's subjective opinion a lint/test failure is
// ground truth worth carrying forward.

// Types

/**
 * Where a reflection entry came from.
 * Objective sources (lint/bs/test) are ground-truth failures that count toward
 * the self-repair budget and are preserved across fresh-context resets.
 * Subjective sources (review) are opinion and are handled by the existing
 * reviewer-feedback channel, not this trail.
 */
export type ReflectionSource = 'lint' | 'bs' | 'test' | 'review';

export interface ReflectionEntry {
  /** 1-based pipeline iteration this failure was observed in */
  iteration: number;
  source: ReflectionSource;
  /** Human-readable error lines (already trimmed by the caller) */
  errors: string[];
}

export interface ReflectionState {
  entries: ReflectionEntry[];
  /**
   * Number of objective self-repair attempts recorded (lint/bs/test).
   * Subjective review revises do NOT increment this — they are not self-repair.
   */
  reflectionCount: number;
}

// Constants

/** Default cap on objective self-repair attempts before giving up. */
export const DEFAULT_MAX_REFLECTIONS = 3;
/** Keep only the most recent N objective entries in the prompt (avoid bloat). */
export const MAX_TRAIL_ENTRIES = 3;
/** Cap error lines per entry so a chatty compiler cannot blow up the prompt. */
const MAX_ERRORS_PER_ENTRY = 5;

const OBJECTIVE_SOURCES: readonly ReflectionSource[] = ['lint', 'bs', 'test'];

// State

export function createReflectionState(): ReflectionState {
  return { entries: [], reflectionCount: 0 };
}

/** True for ground-truth failures that drive (and bound) self-repair. */
export function isObjective(source: ReflectionSource): boolean {
  return OBJECTIVE_SOURCES.includes(source);
}

/** The most recent objective entry, or undefined if none yet. */
function lastObjectiveEntry(state: ReflectionState): ReflectionEntry | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    if (isObjective(state.entries[i].source)) return state.entries[i];
  }
  return undefined;
}

/** Two error lists are "the same failure" when their trimmed lines match exactly. */
function sameErrors(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, i) => line.trim() === b[i].trim());
}

/**
 * Record a failure as a reflection entry.
 *
 * For objective sources this increments the self-repair count and reports
 * whether progress was made — `progressed: false` means this attempt produced
 * the exact same errors as the previous objective attempt (stagnation: the agent
 * is stuck and further retries will only burn tokens).
 *
 * Subjective (review) entries are stored for completeness but never count toward
 * the budget and always report progress (the reviewer channel handles them).
 */
export function recordReflection(
  state: ReflectionState,
  entry: ReflectionEntry,
): { progressed: boolean } {
  const trimmed: ReflectionEntry = {
    iteration: entry.iteration,
    source: entry.source,
    errors: entry.errors.map((e) => e.trim()).filter(Boolean).slice(0, MAX_ERRORS_PER_ENTRY),
  };

  if (!isObjective(trimmed.source)) {
    state.entries.push(trimmed);
    return { progressed: true };
  }

  const prev = lastObjectiveEntry(state);
  const progressed = !prev || !sameErrors(prev.errors, trimmed.errors);

  state.entries.push(trimmed);
  state.reflectionCount += 1;
  return { progressed };
}

/** True once the bounded self-repair budget is spent. */
export function shouldStopReflecting(
  state: ReflectionState,
  max: number = DEFAULT_MAX_REFLECTIONS,
): boolean {
  return state.reflectionCount >= max;
}

/**
 * Build the worker-prompt section that carries forward objective errors from
 * prior attempts. Returns '' when there is nothing objective to reflect on, so
 * the caller can simply concatenate.
 *
 * Only objective entries are emitted (subjective review feedback travels through
 * the reviewer channel). The list is capped to the most recent MAX_TRAIL_ENTRIES.
 */
export function buildReflectionFeedback(state: ReflectionState): string {
  const objective = state.entries.filter((e) => isObjective(e.source));
  if (objective.length === 0) return '';

  const recent = objective.slice(-MAX_TRAIL_ENTRIES);
  const lines: string[] = [];
  lines.push('## Self-Repair Reflection (previous attempts failed these checks)');
  lines.push(
    'Your prior edits were rejected by automated checks below. Treat them as invalid edits: ' +
      'fix the exact errors and do NOT repeat the same mistakes.',
  );

  for (const entry of recent) {
    lines.push('');
    lines.push(`### Attempt @ iteration ${entry.iteration} — ${labelForSource(entry.source)}`);
    entry.errors.forEach((err, i) => lines.push(`${i + 1}. ${err}`));
  }

  return lines.join('\n');
}

function labelForSource(source: ReflectionSource): string {
  switch (source) {
    case 'lint':
      return 'lint / type check failed';
    case 'bs':
      return 'code-smell guard failed';
    case 'test':
      return 'tests failed';
    case 'review':
      return 'reviewer feedback';
  }
}
