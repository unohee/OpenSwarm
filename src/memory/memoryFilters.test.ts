import { describe, expect, it } from 'vitest';
import { clamp01 } from './memoryCore.js';
import {
  isTransientReviewerFailure,
  isTransientReviewRejectionMemory,
} from './memoryFilters.js';

describe('memory score normalization', () => {
  it('normalizes legacy 1-10 scores instead of saturating them to 1.00', () => {
    expect(clamp01(7, 0.5)).toBe(0.7);
    expect(clamp01(9, 0.5)).toBe(0.9);
    expect(clamp01(0.82, 0.5)).toBe(0.82);
  });
});

describe('transient reviewer failure detection', () => {
  it('detects provider/API errors that should not become durable constraints', () => {
    expect(isTransientReviewerFailure('Codex responses error (429): usage_limit_reached')).toBe(true);
    expect(isTransientReviewerFailure('Reviewer execution failed: codex CLI failed with code 1')).toBe(true);
  });

  it('does not classify actionable reviewer findings as transient', () => {
    expect(isTransientReviewerFailure('No files were changed and no verification was run.')).toBe(false);
  });

  it('detects old noisy review rejection memories for compaction cleanup', () => {
    expect(isTransientReviewRejectionMemory({
      type: 'constraint',
      title: 'Review rejection: benchmark',
      content: 'Reviewer feedback: API error: 429 usage_limit_reached',
    })).toBe(true);
  });
});
