import { describe, it, expect } from 'vitest';
import { parseReviewerResult } from './resultParsing.js';

const wrap = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';

describe('parseReviewerResult recommendedActions (INT-1954)', () => {
  it('parses structured recommendedActions on approve', () => {
    const r = parseReviewerResult(
      wrap({
        decision: 'approve',
        feedback: 'lgtm',
        issues: [],
        suggestions: [],
        recommendedActions: [
          { type: 'test', title: 'add edge-case coverage', location: 'src/x.ts:10' },
          { type: 'refactor', title: 'extract helper' },
        ],
      }),
    );
    expect(r.decision).toBe('approve');
    expect(r.recommendedActions).toEqual([
      { type: 'test', title: 'add edge-case coverage', location: 'src/x.ts:10' },
      { type: 'refactor', title: 'extract helper', location: undefined },
    ]);
  });

  it('defaults a missing type to follow-up and drops title-less entries', () => {
    const r = parseReviewerResult(
      wrap({ decision: 'approve', feedback: 'ok', recommendedActions: [{ title: 'do x' }, { type: 'bug' }] }),
    );
    expect(r.recommendedActions).toEqual([{ type: 'follow-up', title: 'do x', location: undefined }]);
  });

  it('is undefined when absent or empty', () => {
    expect(parseReviewerResult(wrap({ decision: 'approve', feedback: 'ok' })).recommendedActions).toBeUndefined();
    expect(
      parseReviewerResult(wrap({ decision: 'approve', feedback: 'ok', recommendedActions: [] })).recommendedActions,
    ).toBeUndefined();
  });
});
