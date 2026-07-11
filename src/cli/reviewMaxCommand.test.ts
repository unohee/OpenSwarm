import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';
import type { AuditRun, AuditSummary } from './reviewAudit.js';

const ensureTaskSourceMock = vi.fn();
const ensureProjectMappingMock = vi.fn();
const resolveIssueFromBranchMock = vi.fn();
vi.mock('./reviewCommand.js', () => ({
  ensureTaskSource: (...args: unknown[]) => ensureTaskSourceMock(...args),
  ensureProjectMapping: (...args: unknown[]) => ensureProjectMappingMock(...args),
  resolveIssueFromBranch: (...args: unknown[]) => resolveIssueFromBranchMock(...args),
  buildReviewWorkerResult: vi.fn(),
}));

const synthesizeAuditIssuesMock = vi.fn();
vi.mock('./auditPM.js', () => ({
  synthesizeAuditIssues: (...args: unknown[]) => synthesizeAuditIssuesMock(...args),
}));

const fileReviewerFollowupsMock = vi.fn();
vi.mock('../automation/runnerExecution.js', () => ({
  fileReviewerFollowups: (...args: unknown[]) => fileReviewerFollowupsMock(...args),
}));

const { filePerAreaFollowups, filePmSynthesizedIssues, reviewMaxResultFailed } = await import('./reviewMaxCommand.js');

function makeRun(actions: ReviewResult['recommendedActions']): AuditRun {
  const review: ReviewResult = { decision: 'revise', feedback: 'x', recommendedActions: actions };
  return {
    results: [{ area: { label: 'src', dir: 'src', files: ['src/a.ts'] }, review }],
    summary: { decision: 'revise', totalAreas: 1, completed: 1, failed: 0, areas: [], issues: [], recommendedActions: actions ?? [] } as AuditSummary,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureTaskSourceMock.mockResolvedValue({ createTask: vi.fn(), createSubIssue: vi.fn() });
  resolveIssueFromBranchMock.mockReturnValue(undefined);
});

describe('reviewMaxResultFailed', () => {
  it('fails closed when --fix leaves a revise verdict unresolved', () => {
    expect(reviewMaxResultFailed({ decision: 'revise', resolved: false }, true)).toBe(true);
    expect(reviewMaxResultFailed({ decision: 'approve', resolved: true }, true)).toBe(false);
  });

  it('preserves report-only review semantics without --fix', () => {
    expect(reviewMaxResultFailed({ decision: 'revise' }, false)).toBe(false);
    expect(reviewMaxResultFailed({ decision: 'reject' }, false)).toBe(true);
  });
});

describe('filePerAreaFollowups (INT-2599)', () => {
  it('skips filing entirely when the project-mapping preflight aborts', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: undefined, abort: true });
    const run = makeRun([{ type: 'bug', title: 'fix it' }]);

    await filePerAreaFollowups('/repo', true, run);

    expect(fileReviewerFollowupsMock).not.toHaveBeenCalled();
  });

  it('threads the resolved projectId into fileReviewerFollowups', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: 'proj-123', abort: false });
    fileReviewerFollowupsMock.mockResolvedValue(1);
    const run = makeRun([{ type: 'bug', title: 'fix it' }]);

    await filePerAreaFollowups('/repo', true, run);

    expect(fileReviewerFollowupsMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
      expect.objectContaining({ projectId: 'proj-123' }),
    );
  });
});

describe('filePmSynthesizedIssues (INT-2599)', () => {
  it('skips creating the master issue and synthesized issues when the preflight aborts', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: undefined, abort: true });
    const source = { createTask: vi.fn(), createSubIssue: vi.fn() };
    ensureTaskSourceMock.mockResolvedValue(source);
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 1,
      completed: 1,
      failed: 0,
      areas: [],
      issues: [],
      recommendedActions: [{ type: 'bug', title: 'fix it' }],
    };

    await filePmSynthesizedIssues('/repo', {}, summary, '# report', '2026-07-10T00-00-00');

    expect(source.createTask).not.toHaveBeenCalled();
    expect(source.createSubIssue).not.toHaveBeenCalled();
    expect(synthesizeAuditIssuesMock).not.toHaveBeenCalled();
  });

  it('passes the resolved projectId to the master issue and synthesized sub-issues', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: 'proj-456', abort: false });
    const source = {
      createTask: vi.fn().mockResolvedValue({ id: 'master-1', identifier: 'INT-1', title: 'master' }),
      createSubIssue: vi.fn().mockResolvedValue({ id: 'sub-1', identifier: 'INT-2', title: 'sub' }),
    };
    ensureTaskSourceMock.mockResolvedValue(source);
    synthesizeAuditIssuesMock.mockResolvedValue([
      { title: 'grouped fix', priority: 2, items: ['fix it'], description: 'body' },
    ]);
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 1,
      completed: 1,
      failed: 0,
      areas: [],
      issues: [],
      recommendedActions: [{ type: 'bug', title: 'fix it' }],
    };

    await filePmSynthesizedIssues('/repo', {}, summary, '# report', '2026-07-10T00-00-00');

    expect(source.createTask).toHaveBeenCalledWith(expect.any(String), '# report', 'proj-456');
    expect(source.createSubIssue).toHaveBeenCalledWith(
      'master-1',
      'grouped fix',
      'body',
      expect.objectContaining({ projectId: 'proj-456' }),
    );
  });
});
