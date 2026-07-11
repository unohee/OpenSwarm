import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';

const { runDraftAnalysis, findOpenPRFileOverlaps, createWorktree } = vi.hoisted(() => ({
  runDraftAnalysis: vi.fn(),
  findOpenPRFileOverlaps: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock('../agents/draftAnalyzer.js', () => ({ runDraftAnalysis }));
vi.mock('../support/worktreeManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/worktreeManager.js')>()),
  findOpenPRFileOverlaps,
  createWorktree,
}));

import { executePipeline, setTaskSource, type ExecutionContext } from './runnerExecution.js';

describe('executePipeline open-PR preflight (INT-2568)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runDraftAnalysis.mockResolvedValue({
      taskType: 'bugfix', relevantFiles: ['src/subtraction.rs'], durationMs: 7,
      intentSummary: 'fix subtraction', completionCriteria: [], sufficient: true,
    });
    findOpenPRFileOverlaps.mockResolvedValue([
      { number: 16, url: 'https://example.test/16', label: 'PR #16', files: ['src/subtraction.rs'] },
    ]);
  });

  it('returns before worktree creation without posting repeat-prone tracker comments', async () => {
    const addComment = vi.fn(async () => {});
    setTaskSource({ kind: 'local', addComment } as unknown as ITaskSource);
    const task: TaskItem = {
      id: 'task-overlap', source: 'linear', issueId: 'issue-overlap', issueIdentifier: 'INT-overlap',
      title: 'Fix subtraction', priority: 3, createdAt: Date.now(),
    };
    const ctx = {
      allowedProjects: ['/repo'], enableDraftAnalysis: true, enableDecomposition: false, worktreeMode: true,
    } as ExecutionContext;

    const first = await executePipeline(ctx, task, '/repo');
    const second = await executePipeline(ctx, task, '/repo');

    expect(first).toMatchObject({ success: true, finalStatus: 'superseded', iterations: 0 });
    expect(second.finalStatus).toBe('superseded');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });
});
