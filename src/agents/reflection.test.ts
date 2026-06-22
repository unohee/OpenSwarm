// Created: 2026-06-22
// Purpose: Unit tests for self-repair reflection (bad-edit guard + bounded reflection loop)
// Test Status: Complete

import { describe, it, expect } from 'vitest';
import {
  createReflectionState,
  isObjective,
  recordReflection,
  shouldStopReflecting,
  buildReflectionFeedback,
  DEFAULT_MAX_REFLECTIONS,
  MAX_TRAIL_ENTRIES,
  type ReflectionState,
} from './reflection.js';

describe('reflection', () => {
  describe('createReflectionState', () => {
    it('starts empty with zero count', () => {
      const s = createReflectionState();
      expect(s.entries).toEqual([]);
      expect(s.reflectionCount).toBe(0);
    });
  });

  describe('isObjective', () => {
    it('treats lint/bs/test as objective', () => {
      expect(isObjective('lint')).toBe(true);
      expect(isObjective('bs')).toBe(true);
      expect(isObjective('test')).toBe(true);
    });

    it('treats review as subjective', () => {
      expect(isObjective('review')).toBe(false);
    });
  });

  describe('recordReflection', () => {
    it('increments count for objective sources only', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['e1'] });
      expect(s.reflectionCount).toBe(1);
      recordReflection(s, { iteration: 2, source: 'review', errors: ['opinion'] });
      expect(s.reflectionCount).toBe(1); // review does not count
      recordReflection(s, { iteration: 3, source: 'test', errors: ['t1'] });
      expect(s.reflectionCount).toBe(2);
    });

    it('reports progress on the first objective failure', () => {
      const s = createReflectionState();
      const { progressed } = recordReflection(s, { iteration: 1, source: 'lint', errors: ['TS2304'] });
      expect(progressed).toBe(true);
    });

    it('reports no progress when identical objective errors repeat', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['TS2304: Cannot find name x'] });
      const second = recordReflection(s, { iteration: 2, source: 'lint', errors: ['TS2304: Cannot find name x'] });
      expect(second.progressed).toBe(false);
    });

    it('reports progress when objective errors change', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['TS2304'] });
      const second = recordReflection(s, { iteration: 2, source: 'lint', errors: ['TS2345'] });
      expect(second.progressed).toBe(true);
    });

    it('compares against the most recent OBJECTIVE entry, ignoring interleaved review', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'test', errors: ['boom'] });
      recordReflection(s, { iteration: 2, source: 'review', errors: ['style nit'] });
      const third = recordReflection(s, { iteration: 3, source: 'test', errors: ['boom'] });
      expect(third.progressed).toBe(false); // same as the prior objective (test), not the review
    });

    it('treats differently-ordered identical errors as different (order-sensitive)', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['a', 'b'] });
      const second = recordReflection(s, { iteration: 2, source: 'lint', errors: ['b', 'a'] });
      expect(second.progressed).toBe(true);
    });

    it('trims and drops empty error lines, capping per-entry', () => {
      const s = createReflectionState();
      const many = Array.from({ length: 20 }, (_, i) => `  err${i}  `);
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['', '  ', ...many] });
      expect(s.entries[0].errors.length).toBeLessThanOrEqual(5);
      expect(s.entries[0].errors[0]).toBe('err0'); // trimmed, empties dropped
    });
  });

  describe('shouldStopReflecting', () => {
    it('is false until the budget is reached', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['e'] });
      expect(shouldStopReflecting(s, 3)).toBe(false);
      recordReflection(s, { iteration: 2, source: 'lint', errors: ['e2'] });
      expect(shouldStopReflecting(s, 3)).toBe(false);
      recordReflection(s, { iteration: 3, source: 'lint', errors: ['e3'] });
      expect(shouldStopReflecting(s, 3)).toBe(true);
    });

    it('defaults to DEFAULT_MAX_REFLECTIONS', () => {
      const s = createReflectionState();
      for (let i = 0; i < DEFAULT_MAX_REFLECTIONS; i++) {
        recordReflection(s, { iteration: i + 1, source: 'test', errors: [`e${i}`] });
      }
      expect(shouldStopReflecting(s)).toBe(true);
    });

    it('lets an operator lower the budget to fail fast', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['e'] });
      expect(shouldStopReflecting(s, 1)).toBe(true);
    });

    it('does not count review failures toward the budget', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'review', errors: ['r1'] });
      recordReflection(s, { iteration: 2, source: 'review', errors: ['r2'] });
      recordReflection(s, { iteration: 3, source: 'review', errors: ['r3'] });
      expect(shouldStopReflecting(s, 3)).toBe(false);
    });
  });

  describe('buildReflectionFeedback', () => {
    it('returns empty string when there are no objective entries', () => {
      const s = createReflectionState();
      expect(buildReflectionFeedback(s)).toBe('');
      recordReflection(s, { iteration: 1, source: 'review', errors: ['just an opinion'] });
      expect(buildReflectionFeedback(s)).toBe('');
    });

    it('renders objective errors with a bad-edit framing', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['TS2304: Cannot find name foo'] });
      const out = buildReflectionFeedback(s);
      expect(out).toContain('Self-Repair Reflection');
      expect(out).toContain('invalid edits');
      expect(out).toContain('TS2304: Cannot find name foo');
      expect(out).toContain('lint / type check failed');
    });

    it('omits subjective review entries from the rendered feedback', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'test', errors: ['test_login failed'] });
      recordReflection(s, { iteration: 2, source: 'review', errors: ['rename this variable'] });
      const out = buildReflectionFeedback(s);
      expect(out).toContain('test_login failed');
      expect(out).not.toContain('rename this variable');
    });

    it('caps the trail to the most recent MAX_TRAIL_ENTRIES objective entries', () => {
      const s = createReflectionState();
      for (let i = 1; i <= MAX_TRAIL_ENTRIES + 2; i++) {
        recordReflection(s, { iteration: i, source: 'lint', errors: [`unique-error-${i}`] });
      }
      const out = buildReflectionFeedback(s);
      // Oldest entries fall off the window
      expect(out).not.toContain('unique-error-1');
      expect(out).not.toContain('unique-error-2');
      // Most recent survive
      expect(out).toContain(`unique-error-${MAX_TRAIL_ENTRIES + 2}`);
    });
  });

  describe('integration: bounded self-repair scenario', () => {
    it('progresses while errors change, then exhausts the budget', () => {
      const s: ReflectionState = createReflectionState();
      const max = 3;
      const r1 = recordReflection(s, { iteration: 1, source: 'lint', errors: ['A'] });
      expect(r1.progressed).toBe(true);
      expect(shouldStopReflecting(s, max)).toBe(false);

      const r2 = recordReflection(s, { iteration: 2, source: 'lint', errors: ['B'] });
      expect(r2.progressed).toBe(true);
      expect(shouldStopReflecting(s, max)).toBe(false);

      const r3 = recordReflection(s, { iteration: 3, source: 'test', errors: ['C'] });
      expect(r3.progressed).toBe(true);
      expect(shouldStopReflecting(s, max)).toBe(true); // budget spent
    });

    it('detects stagnation before the budget is spent', () => {
      const s = createReflectionState();
      recordReflection(s, { iteration: 1, source: 'lint', errors: ['same'] });
      const repeat = recordReflection(s, { iteration: 2, source: 'lint', errors: ['same'] });
      expect(repeat.progressed).toBe(false); // stagnation signal fires at count=2 of 3
      expect(shouldStopReflecting(s, 3)).toBe(false);
    });
  });
});
