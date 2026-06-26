import { describe, it, expect, vi } from 'vitest';
import { buildReviewWorkerResult, formatReviewOutput, runReviewCommand } from './reviewCommand.js';
import type { ReviewResult } from '../agents/agentPair.js';

describe('buildReviewWorkerResult (INT-1955)', () => {
  it('synthesizes a WorkerResult from changed files', () => {
    const wr = buildReviewWorkerResult(['a.ts', 'b.ts']);
    expect(wr).toMatchObject({ success: true, filesChanged: ['a.ts', 'b.ts'], commands: [] });
    expect(wr.summary).toContain('2');
  });
});

describe('formatReviewOutput (INT-1955)', () => {
  it('renders decision, feedback, issues, suggestions, follow-ups', () => {
    const review: ReviewResult = {
      decision: 'approve',
      feedback: 'looks good',
      issues: ['minor naming'],
      suggestions: ['add a test'],
      recommendedActions: [{ type: 'test', title: 'cover edge case', location: 'a.ts:3' }],
    };
    const out = formatReviewOutput(review);
    expect(out).toContain('Decision: APPROVE');
    expect(out).toContain('looks good');
    expect(out).toContain('- minor naming');
    expect(out).toContain('- add a test');
    expect(out).toContain('[test] cover edge case (a.ts:3)');
  });
});

describe('runReviewCommand (INT-1955)', () => {
  it('returns null and skips review when there are no changes', async () => {
    const review = vi.fn();
    const out = await runReviewCommand({}, { getChangedFiles: async () => [], review, log: () => {} });
    expect(out).toBeNull();
    expect(review).not.toHaveBeenCalled();
  });

  it('runs the reviewer over changed files and prints the verdict', async () => {
    const logs: string[] = [];
    const review = vi.fn(async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult);
    const out = await runReviewCommand(
      {},
      { getChangedFiles: async () => ['x.ts'], review, log: (l) => logs.push(l) },
    );
    expect(review).toHaveBeenCalledOnce();
    expect(out?.decision).toBe('approve');
    expect(logs.join('\n')).toContain('Decision: APPROVE');
  });

  it('files follow-ups when --file is set and the reviewer recommends actions', async () => {
    const fileFollowups = vi.fn(async () => 2);
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['x.ts'],
        review: async () =>
          ({ decision: 'approve', feedback: 'ok', recommendedActions: [{ type: 'test', title: 't' }] }) as ReviewResult,
        fileFollowups,
        log: () => {},
      },
    );
    expect(fileFollowups).toHaveBeenCalledWith('INT-1', expect.objectContaining({ decision: 'approve' }));
  });

  it('does not file when there are no recommendedActions', async () => {
    const fileFollowups = vi.fn(async () => 0);
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['x.ts'],
        review: async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult,
        fileFollowups,
        log: () => {},
      },
    );
    expect(fileFollowups).not.toHaveBeenCalled();
  });
});
