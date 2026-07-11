import { describe, it, expect, vi } from 'vitest';
import { fileReviewerFollowups, formatExecutionCommentContext, rateLimitedPipelineResult } from './runnerExecution.js';
import type { ReviewResult } from '../agents/agentPair.js';
import type { ITaskSource } from './taskSource.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

const mockSource = (createSubIssue = vi.fn(async () => ({}))) =>
  ({ createSubIssue } as unknown as ITaskSource);

const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  decision: 'approve',
  feedback: 'lgtm',
  recommendedActions: [
    { type: 'test', title: 'add edge-case coverage', location: 'src/x.ts:10' },
    { type: 'refactor', title: 'extract helper' },
  ],
  ...over,
});

describe('execution issue-comment context (INT-2608)', () => {
  it('keeps all human diagnoses while bounding repetitive automation comments', () => {
    const comments = [
      { createdAt: '2026-07-07T12:47:00Z', body: '근본 원인 확정: nih-plug AU wrapper null-mData 처리 누락' },
      { createdAt: '2026-07-07T13:19:00Z', body: '수정 방향: wrapper.rs scratch buffer 배선' },
      ...Array.from({ length: 8 }, (_, i) => ({
        createdAt: `2026-07-08T0${i}:00:00Z`, body: `**Work complete**\nmitigation attempt ${i}\n\n_Worker audit log · 2026-07-08_`,
      })),
    ];
    const context = formatExecutionCommentContext(comments);
    expect(context).toContain('null-mData');
    expect(context).toContain('scratch buffer');
    expect(context).not.toContain('mitigation attempt 0');
    expect(context).toContain('mitigation attempt 7');
  });

  it('reserves a bounded prompt for the newest human diagnosis', () => {
    const context = formatExecutionCommentContext([
      { createdAt: '2026-07-01T00:00:00Z', body: `old hypothesis ${'x'.repeat(200)}` },
      { createdAt: '2026-07-02T00:00:00Z', body: 'new root cause: wrapper null-mData' },
    ], 140);
    expect(context).toContain('new root cause');
    expect(context).not.toContain('old hypothesis');
    expect(context.length).toBeLessThanOrEqual(140);
  });
});

describe('fileReviewerFollowups (INT-1704)', () => {
  it('is OFF by default — files nothing unless autoFile is set', async () => {
    const src = mockSource();
    expect(await fileReviewerFollowups(src, 'INT-1', review(), {})).toBe(0);
    expect((src.createSubIssue as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('files each recommended action as a sub-issue when approved + enabled', async () => {
    const create = vi.fn(async () => ({}));
    const filed = await fileReviewerFollowups(mockSource(create), 'INT-1', review(), { autoFile: true });
    expect(filed).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toBe('[test] add edge-case coverage'); // title
    expect(create.mock.calls[0][3]).toMatchObject({ priority: 3 });
  });

  it('creates top-level (standalone) issues when no parent is given (INT-1968)', async () => {
    const createSubIssue = vi.fn(async () => ({}));
    const createTask = vi.fn(async () => ({}));
    const src = { createSubIssue, createTask } as unknown as ITaskSource;
    const filed = await fileReviewerFollowups(src, undefined, review(), { autoFile: true, projectId: 'proj-1' });
    expect(filed).toBe(2);
    expect(createSubIssue).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0][0]).toBe('[test] add edge-case coverage'); // title
    expect(createTask.mock.calls[0][2]).toBe('proj-1'); // projectId
  });

  it('does nothing when the reviewer did not approve', async () => {
    const create = vi.fn(async () => ({}));
    expect(await fileReviewerFollowups(mockSource(create), 'INT-1', review({ decision: 'reject' }), { autoFile: true })).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('files regardless of decision when requireApprove is false (INT-1969)', async () => {
    const create = vi.fn(async () => ({}));
    const filed = await fileReviewerFollowups(mockSource(create), 'INT-1', review({ decision: 'revise' }), {
      autoFile: true,
      requireApprove: false,
    });
    expect(filed).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('caps at 10 actions', async () => {
    const create = vi.fn(async () => ({}));
    const many = Array.from({ length: 14 }, (_, i) => ({ type: 'test', title: `t${i}` }));
    const filed = await fileReviewerFollowups(mockSource(create), 'INT-1', review({ recommendedActions: many }), { autoFile: true });
    expect(filed).toBe(10);
    expect(create).toHaveBeenCalledTimes(10);
  });

  it('counts only successful creates and never throws', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'));
    const filed = await fileReviewerFollowups(mockSource(create), 'INT-1', review(), { autoFile: true });
    expect(filed).toBe(1);
  });

  it('handles a null task source gracefully', async () => {
    expect(await fileReviewerFollowups(null, 'INT-1', review(), { autoFile: true })).toBe(0);
  });
});

// The scheduler contract for a pre-pipeline (draft/planner) rate limit: a
// RateLimitError becomes a rate_limited PipelineResult carrying the reset (ms) so
// the runner pauses without counting toward STUCK. (INT-2521)
describe('rateLimitedPipelineResult (INT-2521)', () => {
  it('maps a RateLimitError to a rate_limited result with resetsAt in ms', () => {
    const r = rateLimitedPipelineResult(new RateLimitError(1782824950, 'Codex usage limit reached'));
    expect(r.finalStatus).toBe('rate_limited');
    expect(r.success).toBe(false);
    expect(r.rateLimitResetsAt).toBe(1782824950 * 1000);
  });

  it('leaves resetsAt undefined when the error has none', () => {
    const r = rateLimitedPipelineResult(new RateLimitError(undefined, 'Rate limit reached'));
    expect(r.finalStatus).toBe('rate_limited');
    expect(r.rateLimitResetsAt).toBeUndefined();
  });
});
