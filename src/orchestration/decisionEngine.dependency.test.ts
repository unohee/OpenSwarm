import { describe, it, expect } from 'vitest';
import { computeDownstreamCounts } from './decisionEngine.js';
import type { TaskItem } from './decisionEngine.js';

// blockedBy holds the ids of a task's blockers; computeDownstreamCounts inverts
// that to "how many tasks (transitively) depend on me" — the unblock weight.
const t = (id: string, blockedBy: string[] = []): TaskItem =>
  ({ id, issueId: id, title: id, priority: 3, blockedBy } as TaskItem);

describe('computeDownstreamCounts — dependency graph from blockedBy', () => {
  it('a blocker that gates a chain scores its full transitive downstream', () => {
    // A ← B ← C  (C blockedBy B, B blockedBy A)
    const counts = computeDownstreamCounts([t('A'), t('B', ['A']), t('C', ['B'])]);
    expect(counts.get('A')).toBe(2); // B and C
    expect(counts.get('B')).toBe(1); // C
    expect(counts.get('C')).toBe(0); // leaf
  });

  it('a standalone task with no dependents scores 0 (→ plain priority order)', () => {
    const counts = computeDownstreamCounts([t('X'), t('Y')]);
    expect(counts.get('X')).toBe(0);
    expect(counts.get('Y')).toBe(0);
  });

  it('diamond deps are counted once (no double counting)', () => {
    // A blocks B and C; both B and C block D.  A's downstream = {B,C,D} = 3
    const counts = computeDownstreamCounts([
      t('A'), t('B', ['A']), t('C', ['A']), t('D', ['B', 'C']),
    ]);
    expect(counts.get('A')).toBe(3);
    expect(counts.get('D')).toBe(0);
  });

  it('ignores blockers not in the fetched set', () => {
    // B is blocked by A, but A is not in the set → B has no in-set dependents counted for A
    const counts = computeDownstreamCounts([t('B', ['A']), t('C')]);
    expect(counts.get('B')).toBe(0);
    expect(counts.has('A')).toBe(false);
  });

  it('is cycle-safe (A↔B) and terminates', () => {
    const counts = computeDownstreamCounts([t('A', ['B']), t('B', ['A'])]);
    // both reference each other; counts are finite, no throw/hang
    expect(typeof counts.get('A')).toBe('number');
    expect(typeof counts.get('B')).toBe('number');
  });
});
