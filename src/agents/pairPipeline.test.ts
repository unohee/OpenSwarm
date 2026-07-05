import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
      commands: ['npm test -- src/example.test.ts'],
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

  function initRepo(dir: string): void {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
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

    const result = await pipeline.run(task(), process.cwd());

    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline:stage',
      data: expect.objectContaining({
        stage: 'worker',
        status: 'fail',
        rateLimitResetsAt: 1770000000000,
      }),
    }));
    // A 429 must be classified 'rate_limited' at the pipeline level, not a
    // plain 'failed' — the runner keeps rate-limited attempts out of the
    // STUCK failure count (INT-1906).
    expect(result.finalStatus).toBe('rate_limited');
    // The rethrow that carries the classification to run() must not drop the
    // failed stage from the reported result (INT-2424) — formatters render
    // "No stages" otherwise, even though the worker stage genuinely ran.
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ stage: 'worker', success: false });
  });

  // INT-2424: runStage()'s catch used to swallow a CLI/infra failure into an
  // ordinary StageResult and just retry, so a codex usage-limit or non-zero
  // exit never reached run()'s isInfraError() classification — it silently
  // counted toward the STUCK failure budget like a genuine bad edit.
  it('classifies a worker CLI/infra failure as infra_error, not a plain failure', async () => {
    runWorker.mockRejectedValueOnce(new Error('codex CLI failed with code 1: Reading prompt from stdin...'));
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'fallback-worker', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.finalStatus).toBe('infra_error');
    expect(result.success).toBe(false);
    // Same result-contract guarantee as the rate-limit case above (INT-2424).
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ stage: 'worker', success: false });
  });

  // isInfraError() also classifies a raw (non-Error) rejection — rethrowClassified
  // must not throw a TypeError trying to attach stageResult to a primitive. (INT-2424)
  it('classifies a raw string infra rejection as infra_error, not a plain failure', async () => {
    runWorker.mockRejectedValueOnce('getaddrinfo ENOTFOUND api.openai.com');
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'fallback-worker', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.finalStatus).toBe('infra_error');
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ stage: 'worker', success: false });
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

  it('retries code-changing workers before review when validation commands are missing', async () => {
    runWorker
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed code without checking it',
        filesChanged: ['src/example.ts'],
        commands: [],
        output: '',
        confidencePercent: 95,
      })
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed code and ran a focused test',
        filesChanged: ['src/example.ts'],
        commands: ['npm test -- src/example.test.ts'],
        output: 'PASS src/example.test.ts',
        confidencePercent: 95,
      });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 2,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runReviewer).toHaveBeenCalledTimes(1);
    expect(runWorker.mock.calls[1][0]).toEqual(expect.objectContaining({
      previousFeedback: expect.stringContaining('validation evidence missing'),
    }));
  });

  it('defers to the reviewer instead of hard-failing when validation evidence stays missing', async () => {
    // A worker whose git changes were promoted to success with commands=[]
    // (no JSON block) must not be killed after a couple of retries — the gate is
    // a nudge, so once self-repair stagnates the reviewer gets the final say.
    runWorker.mockResolvedValue({
      success: true,
      summary: 'changed code, never self-reported commands',
      filesChanged: ['src/example.ts'],
      commands: [],
      output: '',
      confidencePercent: 95,
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 4,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    // Reviewer approves → task succeeds despite never getting validation evidence.
    expect(result.success).toBe(true);
    expect(runReviewer).toHaveBeenCalledTimes(1);
  });

  it('does not treat inspection-only commands as validation evidence', async () => {
    runWorker
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed code after searching',
        filesChanged: ['src/example.ts'],
        commands: ['rg "npm test" package.json', 'git grep "cargo test"'],
        output: '',
        confidencePercent: 95,
      })
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed code and ran a script smoke check',
        filesChanged: ['src/example.ts'],
        commands: ['python scripts/smoke_example.py --dry-run'],
        output: 'ok',
        confidencePercent: 95,
      });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 2,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runReviewer).toHaveBeenCalledTimes(1);
    expect(runWorker.mock.calls[1][0]).toEqual(expect.objectContaining({
      previousFeedback: expect.stringContaining('non-validation commands'),
    }));
  });

  it('requires validation for build and dependency manifests without extensions', async () => {
    runWorker
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed runtime manifests without checking them',
        filesChanged: ['Dockerfile', 'Makefile', 'requirements.txt', 'go.mod', 'Cargo.lock'],
        commands: [],
        output: '',
        confidencePercent: 95,
      })
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed manifests and ran a smoke build',
        filesChanged: ['Dockerfile', 'Makefile', 'requirements.txt', 'go.mod', 'Cargo.lock'],
        commands: ['npm run ci'],
        output: 'ok',
        confidencePercent: 95,
      });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 2,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runReviewer).toHaveBeenCalledTimes(1);
    expect(runWorker.mock.calls[1][0]).toEqual(expect.objectContaining({
      previousFeedback: expect.stringContaining('requirements.txt'),
    }));
  });

  it('still requires validation when tester is enabled but would skip manifest-only changes', async () => {
    runWorker
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed package metadata without checking it',
        filesChanged: ['package.json'],
        commands: [],
        output: '',
        confidencePercent: 95,
      })
      .mockResolvedValueOnce({
        success: true,
        summary: 'changed package metadata and ran ci',
        filesChanged: ['package.json'],
        commands: ['npm run ci'],
        output: 'ok',
        confidencePercent: 95,
      });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'tester', 'reviewer'],
      maxIterations: 2,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        tester: { enabled: true, model: 'tester', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runReviewer).toHaveBeenCalledTimes(1);
    expect(runWorker.mock.calls[1][0]).toEqual(expect.objectContaining({
      previousFeedback: expect.stringContaining('validation evidence missing'),
    }));
  });

  it('allows docs-only workers to reach review without validation commands', async () => {
    runWorker.mockResolvedValueOnce({
      success: true,
      summary: 'updated docs',
      filesChanged: ['docs/usage.md'],
      commands: [],
      output: '',
      confidencePercent: 95,
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'worker', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'reviewer', timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task({ title: 'Update docs' }), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runReviewer).toHaveBeenCalledTimes(1);
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

  it('scores core orchestration work as a fan-out candidate without running extra workers', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const draftAnalysis = {
      taskType: 'feature',
      intentSummary: 'Add an adaptive fan-out gate to the worker pipeline.',
      relevantFiles: ['src/agents/pairPipeline.ts', 'src/support/worktreeManager.ts'],
      suggestedApproach: 'Evaluate risk signals before the worker stage and report the decision.',
      completionCriteria: ['A fan-out gate decision is emitted before the worker starts.'],
      sufficient: true,
    };

    const decision = evaluateWorkerFanoutGate({
      task: task({
        title: 'Add adaptive fan-out gate to PairPipeline',
        estimatedMinutes: 45,
      }),
      draftAnalysis,
      iteration: 1,
      config: { minScore: 2 },
    });

    expect(decision.shouldFanOut).toBe(true);
    expect(decision.signals.map((s) => s.code)).toContain('core-orchestration-scope');

    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: {
          enabled: true,
          model: 'mini-worker',
          timeoutMs: 0,
          fanout: { mode: 'report', minScore: 2 },
        },
      },
      draftAnalysis,
    });

    const result = await pipeline.run(task({
      title: 'Add adaptive fan-out gate to PairPipeline',
      estimatedMinutes: 45,
    }), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(1);
    const fanoutEvent = broadcastEvent.mock.calls
      .map(c => c[0])
      .find(e => e.type === 'pipeline:fanout');
    expect(fanoutEvent).toEqual(expect.objectContaining({
      type: 'pipeline:fanout',
      data: expect.objectContaining({
        shouldFanOut: true,
        score: expect.any(Number),
        threshold: 2,
      }),
    }));
  });

  it('executes adaptive fan-out in sandboxes and promotes only the winning diff', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-pipeline-fanout-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        const file = isSpark ? 'spark.txt' : 'primary.txt';
        await writeFile(path.join(opts.projectPath, file), isSpark ? 'spark\n' : 'primary\n', 'utf8');
        return {
          success: true,
          summary: isSpark ? 'spark patch' : 'primary patch',
          filesChanged: [file],
          commands: [],
          output: '',
          confidencePercent: isSpark ? 95 : 70,
        };
      });

      const { PairPipeline } = await import('./pairPipeline.js');
      const pipeline = new PairPipeline({
        stages: ['worker'],
        maxIterations: 1,
        roles: {
          worker: {
            enabled: true,
            adapter: 'codex-responses',
            model: 'gpt-5.4-mini',
            timeoutMs: 0,
            fanout: { mode: 'execute', minScore: 1, concurrency: 2 },
          },
        },
      });

      const result = await pipeline.run(task({
        title: 'Touch PairPipeline worker fan-out',
        estimatedMinutes: 45,
      }), repo);
      expect(result.success).toBe(true);
      expect(runWorker).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(repo, 'spark.txt'), 'utf8')).toBe('spark\n');
      expect(existsSync(path.join(repo, 'primary.txt'))).toBe(false);
      expect(result.workerResult?.summary).toContain('[fanout:spark-diversity]');
      expect(result.workerResult?.filesChanged).toEqual(['spark.txt']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('excludes fan-out candidates whose sandbox diff fails a blocking guard', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-pipeline-fanout-guards-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        if (isSpark) {
          await writeFile(path.join(opts.projectPath, 'package.json'), '{"name":"spoofed-dep"}\n', 'utf8');
          return {
            success: true,
            summary: 'spark patch',
            filesChanged: ['package.json'],
            commands: [],
            output: 'Cannot find module left-pad',
            confidencePercent: 99,
          };
        }

        await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
        return {
          success: true,
          summary: 'primary patch',
          filesChanged: ['primary.txt'],
          commands: [],
          output: '',
          confidencePercent: 90,
        };
      });

      const { PairPipeline } = await import('./pairPipeline.js');
      const pipeline = new PairPipeline({
        stages: ['worker'],
        maxIterations: 1,
        guards: { dependencyAntiPatternCheck: true },
        roles: {
          worker: {
            enabled: true,
            adapter: 'codex-responses',
            model: 'gpt-5.4-mini',
            timeoutMs: 0,
            fanout: { mode: 'execute', minScore: 1, concurrency: 2 },
          },
        },
      });

      const result = await pipeline.run(task({
        title: 'Touch PairPipeline worker fan-out',
        estimatedMinutes: 45,
      }), repo);
      expect(result.success).toBe(true);
      expect(runWorker).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(repo, 'primary.txt'), 'utf8')).toBe('primary\n');
      expect(existsSync(path.join(repo, 'package.json'))).toBe(false);
      expect(result.workerResult?.summary).toContain('[fanout:primary]');
      expect(result.workerResult?.filesChanged).toEqual(['primary.txt']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('copies shared dependency paths into fan-out sandboxes by default', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-pipeline-fanout-deps-'));
    try {
      await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      await mkdir(path.join(repo, 'node_modules', '.bin'), { recursive: true });
      const localCheck = path.join(repo, 'node_modules', '.bin', 'local-check');
      await writeFile(localCheck, '#!/usr/bin/env node\nconsole.log("ok")\n', 'utf8');
      await chmod(localCheck, 0o755);
      initRepo(repo);

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        execFileSync(path.join(opts.projectPath, 'node_modules', '.bin', 'local-check'), [], {
          cwd: opts.projectPath,
        });
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        const file = isSpark ? 'spark.txt' : 'primary.txt';
        await writeFile(path.join(opts.projectPath, file), isSpark ? 'spark\n' : 'primary\n', 'utf8');
        return {
          success: true,
          summary: isSpark ? 'spark patch' : 'primary patch',
          filesChanged: [file],
          commands: ['node_modules/.bin/local-check'],
          output: 'ok',
          confidencePercent: isSpark ? 95 : 70,
        };
      });

      const { PairPipeline } = await import('./pairPipeline.js');
      const pipeline = new PairPipeline({
        stages: ['worker'],
        maxIterations: 1,
        roles: {
          worker: {
            enabled: true,
            adapter: 'codex-responses',
            model: 'gpt-5.4-mini',
            timeoutMs: 0,
            fanout: { mode: 'execute', minScore: 1, concurrency: 2 },
          },
        },
      });

      const result = await pipeline.run(task({
        title: 'Touch PairPipeline worker fan-out',
        estimatedMinutes: 45,
      }), repo);

      expect(result.success).toBe(true);
      expect(runWorker).toHaveBeenCalledTimes(2);
      expect(result.workerResult?.summary).toContain('[fanout:spark-diversity]');
      expect(await readFile(path.join(repo, 'spark.txt'), 'utf8')).toBe('spark\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not let losing fan-out candidates mutate original shared paths by default', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-pipeline-fanout-shared-'));
    try {
      await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      await mkdir(path.join(repo, 'node_modules'), { recursive: true });
      await writeFile(path.join(repo, 'node_modules', 'original.txt'), 'original\n', 'utf8');
      initRepo(repo);

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        if (!isSpark) {
          await mkdir(path.join(opts.projectPath, 'node_modules'), { recursive: true });
          await writeFile(path.join(opts.projectPath, 'node_modules', 'loser-leak.txt'), 'leak\n', 'utf8');
          await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
        } else {
          await writeFile(path.join(opts.projectPath, 'spark.txt'), 'spark\n', 'utf8');
        }
        return {
          success: true,
          summary: isSpark ? 'spark patch' : 'primary patch',
          filesChanged: [isSpark ? 'spark.txt' : 'primary.txt'],
          commands: [],
          output: '',
          confidencePercent: isSpark ? 95 : 70,
        };
      });

      const { PairPipeline } = await import('./pairPipeline.js');
      const pipeline = new PairPipeline({
        stages: ['worker'],
        maxIterations: 1,
        roles: {
          worker: {
            enabled: true,
            adapter: 'codex-responses',
            model: 'gpt-5.4-mini',
            timeoutMs: 0,
            fanout: { mode: 'execute', minScore: 1, concurrency: 2 },
          },
        },
      });

      const result = await pipeline.run(task({
        title: 'Touch PairPipeline worker fan-out',
        estimatedMinutes: 45,
      }), repo);

      expect(result.success).toBe(true);
      expect(await readFile(path.join(repo, 'spark.txt'), 'utf8')).toBe('spark\n');
      expect(existsSync(path.join(repo, 'node_modules', 'loser-leak.txt'))).toBe(false);
      expect(await readFile(path.join(repo, 'node_modules', 'original.txt'), 'utf8')).toBe('original\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the adaptive fan-out gate disabled when configured off', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: {
          enabled: true,
          model: 'mini-worker',
          timeoutMs: 0,
          fanout: { enabled: false },
        },
      },
      draftAnalysis: {
        taskType: 'feature',
        intentSummary: 'Add a risky change to the worker pipeline.',
        relevantFiles: ['src/agents/pairPipeline.ts'],
        suggestedApproach: 'Change the pipeline loop.',
        completionCriteria: ['Pipeline still runs.'],
        sufficient: true,
      },
    });

    await pipeline.run(task({
      title: 'Add adaptive fan-out gate to PairPipeline',
      estimatedMinutes: 45,
    }), process.cwd());

    const fanoutEvent = broadcastEvent.mock.calls
      .map(c => c[0])
      .find(e => e.type === 'pipeline:fanout');
    expect(fanoutEvent).toEqual(expect.objectContaining({
      type: 'pipeline:fanout',
      data: expect.objectContaining({
        enabled: false,
        shouldFanOut: false,
        score: 0,
      }),
    }));
  });
});
