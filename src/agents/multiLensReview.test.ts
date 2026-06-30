// Created: 2026-06-30
// Purpose: Unit tests for multi-lens reviewer fan-out (INT-2230)
// Test Status: Complete

import { describe, it, expect, vi } from 'vitest';
import type { ReviewResult } from './agentPair.js';
import type { ReviewerOptions } from './reviewer.js';
import {
  REVIEW_LENSES,
  buildLensTaskDescription,
  mergeReviewResults,
  shouldFanoutReview,
  runMultiLensReview,
} from './multiLensReview.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

const baseOptions = (): ReviewerOptions => ({
  taskTitle: 'Fix the thing',
  taskDescription: 'Base description',
  projectPath: '/tmp/x',
  workerResult: {
    success: true,
    summary: 's',
    filesChanged: ['a.ts'],
    commands: [],
    output: 'o',
  },
});

describe('mergeReviewResults', () => {
  it('takes the worst decision (reject > revise > approve)', () => {
    const merged = mergeReviewResults([
      { decision: 'approve', feedback: 'a' },
      { decision: 'revise', feedback: 'b' },
      { decision: 'reject', feedback: 'c' },
    ]);
    expect(merged.decision).toBe('reject');
  });

  it('returns approve for empty input', () => {
    const merged = mergeReviewResults([]);
    expect(merged.decision).toBe('approve');
    expect(merged.issues).toEqual([]);
    expect(merged.suggestions).toEqual([]);
    expect(merged.recommendedActions).toEqual([]);
    expect(merged.feedback).toBe('');
  });

  it('unions and dedups issues (case/whitespace-insensitive)', () => {
    const merged = mergeReviewResults([
      { decision: 'revise', feedback: 'f1', issues: ['Null deref', 'Off by one'] },
      { decision: 'approve', feedback: 'f2', issues: ['  null deref  ', 'Race condition'] },
    ]);
    expect(merged.issues).toEqual(['Null deref', 'Off by one', 'Race condition']);
  });

  it('unions and dedups recommendedActions by type|location|title', () => {
    const merged = mergeReviewResults([
      {
        decision: 'approve',
        feedback: 'f1',
        recommendedActions: [{ type: 'test', title: 'Add tests', location: 'a.ts:10' }],
      },
      {
        decision: 'approve',
        feedback: 'f2',
        recommendedActions: [
          { type: 'test', title: 'Add tests', location: 'a.ts:10' }, // duplicate
          { type: 'refactor', title: 'Split fn' },
        ],
      },
    ]);
    expect(merged.recommendedActions).toHaveLength(2);
    expect(merged.recommendedActions?.map((a) => a.title)).toEqual(['Add tests', 'Split fn']);
  });

  it('joins one feedback line per result', () => {
    const merged = mergeReviewResults([
      { decision: 'approve', feedback: '[correctness] looks fine\nextra detail' },
      { decision: 'reject', feedback: '[security] secret leaked' },
    ]);
    expect(merged.feedback).toBe('[correctness] looks fine\n[security] secret leaked');
  });
});

describe('shouldFanoutReview', () => {
  it('triggers when filesChanged meets the default threshold (3)', () => {
    expect(shouldFanoutReview({ filesChanged: ['a', 'b', 'c'] })).toBe(true);
  });

  it('triggers on high priority even with few files', () => {
    expect(shouldFanoutReview({ filesChanged: ['a', 'b'], priority: 1 })).toBe(true);
  });

  it('does not trigger for a small, normal-priority, unlabeled task', () => {
    expect(shouldFanoutReview({ filesChanged: ['a'], priority: 3 })).toBe(false);
  });

  it('triggers on the deep-review label', () => {
    expect(shouldFanoutReview({ filesChanged: ['a'], priority: 3, labels: ['deep-review'] })).toBe(true);
  });

  it('respects a custom fileThreshold', () => {
    expect(shouldFanoutReview({ filesChanged: ['a', 'b'], priority: 4 }, { fileThreshold: 2 })).toBe(true);
  });
});

describe('runMultiLensReview', () => {
  it('runs every lens and merges results', async () => {
    const seen: string[] = [];
    const review = vi.fn(async (o: ReviewerOptions): Promise<ReviewResult> => {
      seen.push(o.taskDescription);
      return { decision: 'approve', feedback: 'ok', issues: [] };
    });

    const merged = await runMultiLensReview(baseOptions(), { review });

    expect(review).toHaveBeenCalledTimes(REVIEW_LENSES.length);
    // Each lens injected its directive into the description.
    for (const lens of REVIEW_LENSES) {
      expect(seen.some((d) => d.includes(`## Review lens: ${lens.key}`))).toBe(true);
    }
    expect(merged.decision).toBe('approve');
  });

  it('produces a reject when any lens rejects', async () => {
    const review = vi.fn(async (o: ReviewerOptions): Promise<ReviewResult> => {
      const isSecurity = o.taskDescription.includes('## Review lens: security');
      return isSecurity
        ? { decision: 'reject', feedback: 'secret leaked', issues: ['leaked key'] }
        : { decision: 'approve', feedback: 'fine' };
    });

    const merged = await runMultiLensReview(baseOptions(), { review });
    expect(merged.decision).toBe('reject');
    expect(merged.issues).toContain('leaked key');
  });

  it('skips a lens that throws a non-rate-limit error', async () => {
    const review = vi.fn(async (o: ReviewerOptions): Promise<ReviewResult> => {
      if (o.taskDescription.includes('## Review lens: security')) {
        throw new Error('cli crashed');
      }
      return { decision: 'revise', feedback: 'meh' };
    });

    const merged = await runMultiLensReview(baseOptions(), { review });
    // Two surviving lenses both revise → revise overall (no throw).
    expect(merged.decision).toBe('revise');
  });

  it('propagates a RateLimitError thrown by any lens', async () => {
    const review = vi.fn(async (o: ReviewerOptions): Promise<ReviewResult> => {
      if (o.taskDescription.includes('## Review lens: security')) {
        throw new RateLimitError(undefined, 'usage limit reached');
      }
      return { decision: 'approve', feedback: 'fine' };
    });

    await expect(runMultiLensReview(baseOptions(), { review })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('buildLensTaskDescription', () => {
  it('appends the lens directive to the base description', () => {
    const out = buildLensTaskDescription('BASE', REVIEW_LENSES[0]);
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('## Review lens: correctness');
    expect(out).toContain(REVIEW_LENSES[0].focus);
  });
});
