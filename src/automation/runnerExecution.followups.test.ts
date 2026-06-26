import { describe, it, expect, vi } from 'vitest';
import { fileReviewerFollowups } from './runnerExecution.js';
import type { ReviewResult } from '../agents/agentPair.js';
import type { ITaskSource } from './taskSource.js';

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
