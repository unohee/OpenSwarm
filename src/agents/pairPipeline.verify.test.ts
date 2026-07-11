import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { VerifyCommand } from '../verify/manifest.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runTester = vi.fn();
const loadVerifyManifest = vi.fn();
const discoverVerifyCommands = vi.fn();
const runVerify = vi.fn();
const resolveBaseRef = vi.fn();

vi.mock('./worker.js', async () => ({
  ...(await vi.importActual<typeof import('./worker.js')>('./worker.js')),
  runWorker,
}));
vi.mock('./reviewer.js', async () => ({
  ...(await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js')),
  runReviewer,
}));
vi.mock('./tester.js', async () => ({
  ...(await vi.importActual<typeof import('./tester.js')>('./tester.js')),
  runTester,
}));
vi.mock('../verify/manifest.js', async () => ({
  ...(await vi.importActual<typeof import('../verify/manifest.js')>('../verify/manifest.js')),
  loadVerifyManifest,
}));
vi.mock('../verify/discover.js', () => ({ discoverVerifyCommands }));
vi.mock('../verify/runner.js', () => ({ runVerify }));
vi.mock('../support/worktreeManager.js', async () => ({
  ...(await vi.importActual<typeof import('../support/worktreeManager.js')>('../support/worktreeManager.js')),
  resolveBaseRef,
}));
vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../adapters/index.js', async () => ({
  ...(await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js')),
  getAdapter: () => ({ getDefaultModel: vi.fn().mockResolvedValue('default-model') }),
}));

const verifyCommand: VerifyCommand = {
  name: 'unit tests',
  run: 'npm test',
  kind: 'test',
  timeoutMs: 300_000,
};

function task(): TaskItem {
  return {
    id: 'verify-task',
    source: 'linear',
    title: 'verify deterministic tester',
    description: 'exercise deterministic tester selection',
    priority: 1,
    createdAt: Date.now(),
  };
}

async function runPipeline(options: { continueOnTestFail?: boolean; verbose?: boolean } = {}) {
  const { PairPipeline } = await import('./pairPipeline.js');
  const pipeline = new PairPipeline({
    stages: ['worker', 'tester', 'reviewer'],
    maxIterations: 1,
    skipTesterIfNoCodeChange: false,
    ...options,
  });
  const logs: string[] = [];
  pipeline.on('log', ({ line }) => logs.push(line));
  return { result: await pipeline.run(task(), process.cwd()), logs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  runWorker.mockResolvedValue({
    success: true,
    summary: 'implemented',
    filesChanged: ['src/example.ts'],
    commands: [],
    output: '',
    confidencePercent: 100,
  });
  runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'approved' });
  runTester.mockResolvedValue({ success: true, testsPassed: 1, testsFailed: 0, output: 'LLM tester' });
  loadVerifyManifest.mockResolvedValue({ manifest: null });
  discoverVerifyCommands.mockResolvedValue([]);
  resolveBaseRef.mockResolvedValue({ remote: 'origin', branch: 'main', ref: 'origin/main' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PairPipeline deterministic tester (INT-2662)', () => {
  it('uses manifest commands without calling the LLM tester', async () => {
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'skipped',
      headStatus: 'pass',
      newFailure: false,
      rawOutputTail: '1 passed',
      durationMs: 5,
    }]);
    const { result, logs } = await runPipeline({ verbose: true });
    expect(result.success).toBe(true);
    expect(result.testerResult).toMatchObject({ success: true, deterministic: true, testsPassed: 1, testsFailed: 0 });
    expect(runTester).not.toHaveBeenCalled();
    expect(discoverVerifyCommands).not.toHaveBeenCalled();
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining({
      verificationEvidence: [expect.objectContaining({ headStatus: 'pass', newFailure: false })],
    }));
    expect(logs).toContainEqual(expect.stringContaining('(deterministic)'));
  });

  it('uses discovered commands when the manifest is absent', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'fail',
      headStatus: 'fail',
      newFailure: false,
      rawOutputTail: 'pre-existing failure',
      durationMs: 5,
    }]);
    const { result } = await runPipeline();
    expect(result.success).toBe(true);
    expect(result.testerResult).toMatchObject({ deterministic: true, testsPassed: 1, testsFailed: 0 });
    expect(runTester).not.toHaveBeenCalled();
  });

  it('falls back to the LLM tester only when no commands are available', async () => {
    const { result } = await runPipeline();
    expect(result.success).toBe(true);
    expect(runTester).toHaveBeenCalledOnce();
    expect(result.testerResult?.deterministic).toBeUndefined();
  });

  it('propagates deterministic infrastructure failures as infra_error', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'skipped',
      headStatus: 'infra',
      newFailure: false,
      rawOutputTail: 'timeout after 20ms',
      durationMs: 20,
    }]);
    const { result } = await runPipeline();
    expect(result).toMatchObject({ success: false, finalStatus: 'infra_error' });
    expect(result.stages.at(-1)).toMatchObject({ stage: 'tester', success: false });
  });

  it('keeps an approved task successful when continueOnTestFail is enabled', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'pass',
      headStatus: 'fail',
      newFailure: true,
      rawOutputTail: 'new regression',
      durationMs: 5,
    }]);
    const { result } = await runPipeline({ continueOnTestFail: true });
    expect(result.success).toBe(true);
    expect(result.testerResult).toMatchObject({ success: false, deterministic: true, failedTests: ['unit tests'] });
    expect(runReviewer).toHaveBeenCalledOnce();
  });
});
