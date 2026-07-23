import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  /** Set per test: what PairPipeline.run() does. */
  run: vi.fn(),
  constructed: [] as unknown[],
  isAvailable: vi.fn(async () => true),
  availableAdapters: vi.fn(async () => ['test']),
  recordTaskOutcome: vi.fn(async () => {}),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ isAvailable: mocks.isAvailable }),
  getDefaultAdapterName: () => 'test',
  listAvailableAdapters: mocks.availableAdapters,
}));

vi.mock('../agents/pairPipeline.js', () => ({
  PairPipeline: class {
    constructor(config: unknown) { mocks.constructed.push(config); }
    on(event: string, handler: (payload: unknown) => void): void {
      mocks.handlers.set(event, handler);
    }
    async run(task: unknown, projectPath: unknown): Promise<unknown> {
      return mocks.run(task, projectPath);
    }
  },
}));

vi.mock('../cli/reviewProgress.js', () => ({
  startProgressHeartbeat: () => ({ stop: mocks.stop }),
}));

vi.mock('../memory/repoKnowledge.js', () => ({ recordTaskOutcome: mocks.recordTaskOutcome }));

import { runCli } from './cliRunner.js';

function pipelineResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    finalStatus: 'approved',
    iterations: 1,
    totalDuration: 1500,
    workerResult: { filesChanged: ['a.ts'], commands: [], summary: 'did the thing' },
    ...overrides,
  };
}

/** runCli always ends in process.exit; surface that as a throw we can assert on. */
function expectExit(code: number, promise: Promise<unknown>) {
  return expect(promise).rejects.toThrow(`exit:${code}`);
}

describe('runCli', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    mocks.stop.mockReset();
    mocks.handlers.clear();
    mocks.constructed.length = 0;
    mocks.run.mockReset().mockResolvedValue(pipelineResult());
    mocks.isAvailable.mockReset().mockResolvedValue(true);
    mocks.availableAdapters.mockReset().mockResolvedValue(['test']);
    mocks.recordTaskOutcome.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  describe('preflight', () => {
    it('lists the alternatives when the default adapter cannot run', async () => {
      mocks.isAvailable.mockResolvedValue(false);
      mocks.availableAdapters.mockResolvedValue(['codex', 'claude']);

      await expectExit(1, runCli({ task: 't', projectPath: process.cwd() }));

      expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n'))
        .toContain('Available adapters: codex, claude');
    });

    it('says so plainly when no adapter at all is available', async () => {
      mocks.isAvailable.mockResolvedValue(false);
      mocks.availableAdapters.mockResolvedValue([]);

      await expectExit(1, runCli({ task: 't', projectPath: process.cwd() }));

      expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n'))
        .toContain('No registered adapters are currently available.');
    });

    it('rejects a project path that does not exist', async () => {
      await expectExit(1, runCli({ task: 't', projectPath: '/definitely/not/here-openswarm' }));

      expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n'))
        .toContain('does not exist');
    });

    it('rejects a project path that is a file', async () => {
      await expectExit(1, runCli({ task: 't', projectPath: `${process.cwd()}/package.json` }));

      expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n'))
        .toContain('is not a directory');
    });

    it.each([0, -1, 2.5, NaN])('rejects a non-positive-integer iteration cap: %s', async (value) => {
      await expectExit(1, runCli({ task: 't', projectPath: process.cwd(), maxIterations: value }));
    });
  });

  describe('pipeline shape', () => {
    it('runs worker + reviewer by default', async () => {
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));

      expect(mocks.constructed[0]).toMatchObject({ stages: ['worker', 'reviewer'], maxIterations: 3 });
    });

    it('runs the worker alone with workerOnly', async () => {
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), workerOnly: true }));

      expect(mocks.constructed[0]).toMatchObject({ stages: ['worker'] });
    });

    it('runs the full four-stage pipeline with pipeline: true', async () => {
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), pipeline: true }));

      expect(mocks.constructed[0]).toMatchObject({
        stages: ['worker', 'reviewer', 'tester', 'documenter'],
      });
    });

    it('pins the worker model only when one was requested', async () => {
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), model: 'sonnet', maxIterations: 5 }));
      expect(mocks.constructed[0]).toMatchObject({
        maxIterations: 5, roles: { worker: { enabled: true, model: 'sonnet', timeoutMs: 0 } },
      });

      mocks.constructed.length = 0;
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));
      expect((mocks.constructed[0] as { roles?: unknown }).roles).toBeUndefined();
    });
  });

  describe('progress output', () => {
    it('uses the animated heartbeat on a TTY and plain lines otherwise', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      mocks.run.mockImplementation(async () => {
        mocks.handlers.get('stage:start')?.({ stage: 'worker' });
        mocks.handlers.get('stage:complete')?.({ stage: 'worker', result: { success: true, duration: 1200 } });
        return pipelineResult();
      });

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));
      expect(mocks.stop).toHaveBeenCalled();

      // Verbose forces the plain-line path even on a TTY.
      mocks.stop.mockReset();
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), verbose: true }));
      expect(mocks.stop).not.toHaveBeenCalled();
    });

    it('marks failed and errored stages, and labels repeat iterations', async () => {
      mocks.run.mockImplementation(async () => {
        mocks.handlers.get('stage:complete')?.({ stage: 'reviewer', result: { success: false, duration: 900 } });
        mocks.handlers.get('stage:fail')?.({ stage: 'tester', result: { duration: 500 } });
        mocks.handlers.get('iteration:start')?.({ iteration: 1, maxIterations: 3 });
        mocks.handlers.get('iteration:start')?.({ iteration: 2, maxIterations: 3 });
        return pipelineResult();
      });

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));

      const written = (process.stdout.write as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('');
      expect(written).toContain('reviewer');
      expect(written).toContain('FAILED');
      const logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('Iteration 2/3');
      expect(logged).not.toContain('Iteration 1/3');
    });

    it('wires the verbose-only listeners', async () => {
      mocks.run.mockImplementation(async () => {
        mocks.handlers.get('log')?.({ line: 'tool call' });
        mocks.handlers.get('halt')?.({ reason: 'budget', sessionId: 's1' });
        mocks.handlers.get('stuck')?.({ sessionId: 's1', iteration: 2 });
        mocks.handlers.get('iteration:fail')?.({ iteration: 2, reason: 'rejected' });
        mocks.handlers.get('iteration:fail')?.({ iteration: 3 });
        mocks.handlers.get('iteration:complete')?.({ iteration: 3 });
        return pipelineResult();
      });

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), verbose: true }));

      const logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('tool call');
      expect(logged).toContain('HALT: budget');
      expect(logged).toContain('STUCK detected at iteration 2');
      expect(logged).toContain('Iteration 2 failed: rejected');
      expect(logged).toContain('Iteration 3 failed');
      expect(logged).toContain('Iteration 3 completed');
    });

    it('stops the live progress heartbeat before exiting on a pipeline error', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      mocks.run.mockImplementation(async () => {
        mocks.handlers.get('stage:start')?.({ stage: 'worker' });
        throw new Error('pipeline boom');
      });

      await expectExit(1, runCli({ task: 'test', projectPath: process.cwd() }));
      expect(mocks.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('result reporting', () => {
    it('prints summary, file list, cost and duration', async () => {
      mocks.run.mockResolvedValue(pipelineResult({
        totalCost: { costUsd: 0.1234 },
        totalDuration: 65_000,
        workerResult: { filesChanged: ['a.ts', 'b.ts'], commands: [], summary: 'done' },
      }));

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));

      const logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('Result: APPROVED');
      expect(logged).toContain('Summary: done');
      expect(logged).toContain('Files:   a.ts, b.ts');
      expect(logged).toContain('$0.1234');
      expect(logged).toContain('1m 5s');
    });

    it('truncates a long file list and formats sub-second and sub-minute runs', async () => {
      mocks.run.mockResolvedValue(pipelineResult({
        totalDuration: 800,
        workerResult: { filesChanged: ['1', '2', '3', '4', '5', '6', '7'], commands: [], summary: '' },
      }));
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));
      let logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('1, 2, 3, 4, 5 +2 more');
      expect(logged).toContain('800ms');

      (console.log as unknown as { mockClear(): void }).mockClear();
      mocks.run.mockResolvedValue(pipelineResult({ totalDuration: 5_500, workerResult: null }));
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));
      logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('5.5s');
      expect(logged).not.toContain('Files:');
    });

    it('shows at most five feedback lines when the run failed', async () => {
      mocks.run.mockResolvedValue(pipelineResult({
        success: false,
        finalStatus: 'rejected',
        reviewResult: { feedback: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n') },
      }));

      await expectExit(1, runCli({ task: 't', projectPath: process.cwd() }));

      const logged = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls.flat().join('\n');
      expect(logged).toContain('Result: REJECTED');
      expect(logged).toContain('l5');
      expect(logged).not.toContain('l6');
    });
  });

  describe('repo knowledge learning', () => {
    it('records the outcome by default, including rejection feedback', async () => {
      mocks.run.mockResolvedValue(pipelineResult({
        success: false, finalStatus: 'rejected', reviewResult: { feedback: 'needs tests' },
      }));

      await expectExit(1, runCli({ task: 'my task', projectPath: process.cwd() }));

      expect(mocks.recordTaskOutcome).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
        taskTitle: 'my task', rejectionFeedback: 'needs tests', derivedFrom: 'cli:run',
      }));
    });

    it('passes a null worker result through instead of fabricating one', async () => {
      mocks.run.mockResolvedValue(pipelineResult({ workerResult: null }));

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));

      expect(mocks.recordTaskOutcome.mock.calls[0][1]).toMatchObject({ workerResult: null });
    });

    it('skips recording when --no-learn was passed', async () => {
      await expectExit(0, runCli({ task: 't', projectPath: process.cwd(), learn: false }));

      expect(mocks.recordTaskOutcome).not.toHaveBeenCalled();
    });

    it('never lets a learning failure change the exit code', async () => {
      mocks.recordTaskOutcome.mockRejectedValue(new Error('lance down'));

      await expectExit(0, runCli({ task: 't', projectPath: process.cwd() }));
    });
  });
});
