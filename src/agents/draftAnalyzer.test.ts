import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CliAdapter, CliRunResult } from '../adapters/types.js';
import { runDraftAnalysis, isDraftSufficient } from './draftAnalyzer.js';
import * as adapterModule from '../adapters/index.js';
import * as knowledgeModule from '../knowledge/index.js';
import * as registryModule from '../registry/sqliteStore.js';

describe('runDraftAnalysis fallback', () => {
  const makeAdapter = (name: string): CliAdapter => ({
    name,
    capabilities: {
      supportsStreaming: true,
      supportsJsonOutput: true,
      supportsModelSelection: true,
      managedGit: false,
      supportedSkills: [],
    },
    isAvailable: vi.fn(async () => true),
    getDefaultModel: vi.fn(async () => 'default-model'),
    buildCommand: () => ({ command: 'echo', args: [] }),
    parseWorkerOutput: vi.fn(() => ({
      success: false,
      summary: '',
      filesChanged: [],
      commands: [],
      output: '',
    })),
    parseReviewerOutput: vi.fn(() => ({
      decision: 'approve',
      feedback: 'ok',
      issues: [],
      suggestions: [],
    })),
  });

  const baseRegistryStore = {
    getStats: vi.fn(() => ({
      total: 0,
      deprecated: 0,
      untested: 0,
      withWarnings: 0,
      highRisk: 0,
    })),
    highRiskEntities: vi.fn(() => []),
    fileBrief: vi.fn(() => ({
      filePath: 'src/index.ts',
      summary: 'ok',
      entities: [],
    })),
  };

  beforeEach(() => {
    vi.spyOn(knowledgeModule, 'analyzeIssue').mockResolvedValue(null);
    vi.spyOn(registryModule, 'getRegistryStore').mockReturnValue(baseRegistryStore as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT fall back to claude on a codex quota error (single adapter, best-effort)', async () => {
    // INT-1979 follow-up: claude is no longer a draft fallback. A codex quota error
    // must NOT switch providers (claude is opt-in / usually out-of-credits, which
    // turned a transient blip into a hard `claude CLI failed code 1` + noisy alert).
    // Draft is non-blocking, so the quota error just yields a best-effort draft.
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockImplementation((name) => makeAdapter(name));

    vi.spyOn(adapterModule, 'spawnCli')
      .mockRejectedValueOnce(new Error('quota exceeded'));

    const result = await runDraftAnalysis({
      taskTitle: 'Fix edge',
      taskDescription: 'Test',
      projectPath: '/tmp/project',
    });

    // codex is tried; claude is never invoked.
    expect(adapterModule.getAdapter).toHaveBeenCalledWith('codex');
    expect(adapterModule.getAdapter).not.toHaveBeenCalledWith('claude');
    // Single adapter attempt only — quota error breaks out to best-effort, no fallback.
    expect(adapterModule.spawnCli).toHaveBeenCalledTimes(1);
    // Pipeline continues with a best-effort (insufficient) draft.
    expect(result.sufficient).toBe(false);
  });

  it('drafter hard gate: retries on the same adapter when the brief is insufficient', async () => {
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(makeAdapter('codex'));

    vi.spyOn(adapterModule, 'spawnCli')
      // attempt 1: thin brief (no completionCriteria) → insufficient → retry
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          taskType: 'feature',
          intentSummary: 'do the thing',
          relevantFiles: [],
          suggestedApproach: 'figure it out',
        }),
        stderr: '',
        durationMs: 1,
      } as CliRunResult)
      // attempt 2: faithful brief with execution-grounded criteria → sufficient
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          taskType: 'feature',
          intentSummary: 'Wire the resolver into the streaming path',
          relevantFiles: ['src/streaming.ts'],
          suggestedApproach: 'call resolve_turn_model from build_request',
          completionCriteria: ['resolve_turn_model invoked from streaming.ts (call site cited)'],
        }),
        stderr: '',
        durationMs: 1,
      } as CliRunResult);

    const result = await runDraftAnalysis({
      taskTitle: 'Wire resolver',
      taskDescription: 'Test',
      projectPath: '/tmp/project',
    });

    expect(adapterModule.spawnCli).toHaveBeenCalledTimes(2); // gate retry on same adapter
    expect(result.sufficient).toBe(true);
    expect(result.completionCriteria).toHaveLength(1);
  });

  it('drafter hard gate: marks insufficient when retries still yield a thin brief', async () => {
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(makeAdapter('codex'));
    // Always thin → never passes the gate.
    vi.spyOn(adapterModule, 'spawnCli').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ taskType: 'feature', intentSummary: 'x', relevantFiles: [], suggestedApproach: 'y' }),
      stderr: '',
      durationMs: 1,
    } as CliRunResult);

    const result = await runDraftAnalysis({ taskTitle: 'T', taskDescription: 'D', projectPath: '/tmp/project' });

    expect(adapterModule.spawnCli).toHaveBeenCalledTimes(2); // exhausts gate retries
    expect(result.sufficient).toBe(false);
  });

  it('does not fallback on non-quota failures', async () => {
    vi.spyOn(adapterModule, 'getDefaultAdapterName').mockReturnValue('codex');
    vi.spyOn(adapterModule, 'getAdapter').mockReturnValue(makeAdapter('codex'));
    vi.spyOn(adapterModule, 'spawnCli').mockRejectedValueOnce(new Error('syntax error'));

    const result = await runDraftAnalysis({
      taskTitle: 'Fix edge',
      taskDescription: 'Test',
      projectPath: '/tmp/project',
    });

    expect(result.taskType).toBe('unknown');
    expect(adapterModule.getAdapter).toHaveBeenCalledTimes(1);
    expect(adapterModule.spawnCli).toHaveBeenCalledTimes(1);
  });
});

describe('isDraftSufficient — drafter hard gate (INT-1917)', () => {
  const ok = {
    intentSummary: 'Wire the resolver into streaming',
    suggestedApproach: 'call resolve from build_request',
    relevantFiles: ['src/streaming.ts'],
    completionCriteria: ['resolver invoked from streaming.ts (call site)'],
  };

  it('passes a faithful brief (intent + files + criteria + approach)', () => {
    expect(isDraftSufficient(ok)).toBe(true);
  });

  it('fails when completionCriteria is empty', () => {
    expect(isDraftSufficient({ ...ok, completionCriteria: [] })).toBe(false);
  });

  it('fails when relevantFiles is empty', () => {
    expect(isDraftSufficient({ ...ok, relevantFiles: [] })).toBe(false);
  });

  it('fails on a too-thin intent or approach', () => {
    expect(isDraftSufficient({ ...ok, intentSummary: 'x' })).toBe(false);
    expect(isDraftSufficient({ ...ok, suggestedApproach: 'y' })).toBe(false);
  });

  it('fails on an empty draft', () => {
    expect(isDraftSufficient({})).toBe(false);
  });
});

