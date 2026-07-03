import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const broadcastEvent = vi.fn();
const getDefaultModel = vi.fn();

// Override runWorker only; keep the real pure helpers (e.g. resolveWorkerBashTimeoutMs
// the worker stage now calls to set bashTimeoutMs — INT-2415).
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

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

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

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
    getDefaultModel.mockResolvedValue('codex-live-model');
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
      // No effort/repo override on this profile → 5min default reaches the worker. (INT-2415)
      bashTimeoutMs: 300_000,
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

  // INT-2393: when role model is omitted, the pipeline:stage events must carry
  // the adapter's real default model so the TUI/dashboard can display it.
  function stageModels(): (string | undefined)[] {
    return broadcastEvent.mock.calls
      .map(c => c[0])
      .filter(e => e.type === 'pipeline:stage')
      .map(e => e.data.model);
  }

  it('resolves the adapter default model when role model is omitted, and caches it', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },   // no model → adapter default
        reviewer: { enabled: true, timeoutMs: 0 },
      },
    });

    await pipeline.run(task(), process.cwd());

    const models = stageModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(m => m === 'codex-live-model')).toBe(true);
    // worker + reviewer share the '<default>' adapter key → resolved once.
    expect(getDefaultModel).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit role model over the adapter default (no getDefaultModel call)', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: { worker: { enabled: true, model: 'explicit-worker', timeoutMs: 0 } },
    });

    await pipeline.run(task(), process.cwd());

    expect(stageModels().every(m => m === 'explicit-worker')).toBe(true);
    expect(getDefaultModel).not.toHaveBeenCalled();
  });

  it('degrades to an undefined model when getDefaultModel fails', async () => {
    getDefaultModel.mockRejectedValue(new Error('no auth'));
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    await pipeline.run(task(), process.cwd());

    expect(stageModels().every(m => m === undefined)).toBe(true);
  });
});
