import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const broadcastEvent = vi.fn();

vi.mock('./worker.js', () => ({
  runWorker,
}));

vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return {
    ...actual,
    runReviewer,
  };
});

vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock('../core/eventHub.js', () => ({
  broadcastEvent,
}));

describe('PairPipeline model selection', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: [],
      output: '',
      confidencePercent: 100,
    });
    runReviewer.mockResolvedValue({
      decision: 'approve',
      feedback: 'approved',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function task(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'task-1',
      source: 'linear',
      title: 'heavy task',
      description: 'exercise job profile model routing',
      priority: 1,
      createdAt: Date.now(),
      estimatedMinutes: 60,
      ...overrides,
    };
  }

  it('passes matched jobProfile models to worker and reviewer calls', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'fallback-worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'fallback-reviewer', timeoutMs: 0 },
      },
      jobProfiles: [{
        name: 'heavy',
        minMinutes: 30,
        roles: {
          worker: 'profile-worker',
          reviewer: 'profile-reviewer',
        },
      }],
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining<Partial<WorkerOptions>>({
      model: 'profile-worker',
    }));
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining<Partial<ReviewerOptions>>({
      model: 'profile-reviewer',
    }));
  });

  it('falls back to role models when no jobProfile matches', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'fallback-worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'fallback-reviewer', timeoutMs: 0 },
      },
      jobProfiles: [{
        name: 'heavy',
        minMinutes: 120,
        roles: {
          worker: 'profile-worker',
          reviewer: 'profile-reviewer',
        },
      }],
    });

    const result = await pipeline.run(task({ estimatedMinutes: 30 }), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining<Partial<WorkerOptions>>({
      model: 'fallback-worker',
    }));
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining<Partial<ReviewerOptions>>({
      model: 'fallback-reviewer',
    }));
  });

  it('emits rate-limit reset timestamps on failed stage events', async () => {
    runWorker.mockRejectedValueOnce(new RateLimitError(1770000000, 'rate limited'));
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'fallback-worker', timeoutMs: 0 },
      },
    });

    await pipeline.run(task(), process.cwd());

    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline:stage',
      data: expect.objectContaining({
        stage: 'worker',
        status: 'fail',
        rateLimitResetsAt: 1770000000000,
      }),
    }));
  });
});
