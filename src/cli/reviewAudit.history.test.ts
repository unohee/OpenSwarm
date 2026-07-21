import { beforeEach, describe, expect, it, vi } from 'vitest';

const runReviewerMock = vi.fn();
vi.mock('../agents/reviewer.js', () => ({ runReviewer: runReviewerMock }));
vi.mock('./reviewCommand.js', () => ({
  buildReviewWorkerResult: (files: string[]) => ({
    success: true,
    summary: 'audit',
    filesChanged: files,
    commands: [],
    output: '',
  }),
}));

const { runMaxReview } = await import('./reviewAudit.js');

describe('runMaxReview prior history', () => {
  beforeEach(() => {
    runReviewerMock.mockReset();
    runReviewerMock.mockResolvedValue({ decision: 'approve', feedback: 'ok' });
  });

  it('forwards the matching repository review log to the default area reviewer', async () => {
    const area = { label: 'src/auth', dir: 'src/auth', files: ['src/auth/a.ts'] };
    await runMaxReview([area], '/repo', {
      concurrency: 1,
      priorReviewContextByArea: { 'src/auth': 'prior auth review' },
    });

    expect(runReviewerMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'audit',
      priorReviewContext: 'prior auth review',
    }));
  });
});
