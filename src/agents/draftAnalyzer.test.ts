import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CliAdapter, CliRunResult } from '../adapters/types.js';
import { runDraftAnalysis, isDraftSufficient, draftBudgetFor, deriveRegistryProjectId } from './draftAnalyzer.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('draftBudgetFor (file-count-adaptive read/analyze budget, INT-2485)', () => {
  it('gives a small repo the base budget (still > the old 30s that timed out)', () => {
    // WAVE = 306 files, kyte-portal = 874, most repos 300-900 → base tier.
    expect(draftBudgetFor(306)).toEqual({ timeoutMs: 60_000, maxTurns: 4 });
    expect(draftBudgetFor(0)).toEqual({ timeoutMs: 60_000, maxTurns: 4 });
  });

  it('scales up with file count', () => {
    expect(draftBudgetFor(400).timeoutMs).toBe(90_000);
    expect(draftBudgetFor(1_200).timeoutMs).toBe(120_000);
    // STONKS = 2253 files → still the 1200 tier; a very large repo → top tier.
    expect(draftBudgetFor(2_253).timeoutMs).toBe(120_000);
    expect(draftBudgetFor(5_000)).toEqual({ timeoutMs: 180_000, maxTurns: 8 });
  });

  it('is monotonic in timeout and turns', () => {
    const sizes = [0, 400, 1_200, 3_000, 10_000];
    const budgets = sizes.map(draftBudgetFor);
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i].timeoutMs).toBeGreaterThanOrEqual(budgets[i - 1].timeoutMs);
      expect(budgets[i].maxTurns).toBeGreaterThanOrEqual(budgets[i - 1].maxTurns);
    }
  });
});


describe('deriveRegistryProjectId (INT-2502 read-side)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'osw-draft-pid-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the package.json name (scope stripped) when present', () => {
    const repo = join(root, 'SomeDir');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: '@intrect/openswarm' }));
    expect(deriveRegistryProjectId(repo)).toBe('openswarm');
  });

  it('falls back to the dir basename without package.json (Rust/Python repos)', () => {
    const repo = join(root, 'WAVE');
    mkdirSync(repo, { recursive: true });
    expect(deriveRegistryProjectId(repo)).toBe('WAVE');
  });

  it('keys a worktree path under its parent repo, not the worktree uuid', () => {
    const wt = join(root, 'WAVE', 'worktree', 'c771f200-5cdf-485e-80c6');
    mkdirSync(wt, { recursive: true });
    expect(deriveRegistryProjectId(wt)).toBe('WAVE');
  });
});

describe('parseDraftResponse robustness (INT-2485 follow-up)', () => {
  const brief = { taskType: 'bugfix', intentSummary: 'Fix the cursor reset between pages properly', relevantFiles: ['src/api/pager.py'], suggestedApproach: 'Thread the cursor through list_items and cover with a test', completionCriteria: ['cursor survives page 2 (test asserts)'] };

  it('accepts an untagged code fence', async () => {
    const { parseDraftResponse } = await import('./draftAnalyzer.js');
    const r = parseDraftResponse('Here is the brief:\n```\n' + JSON.stringify(brief) + '\n```');
    expect(r.taskType).toBe('bugfix');
    expect(r.relevantFiles).toEqual(['src/api/pager.py']);
  });

  it('accepts an uppercase JSON fence tag', async () => {
    const { parseDraftResponse } = await import('./draftAnalyzer.js');
    const r = parseDraftResponse('```JSON\n' + JSON.stringify(brief) + '\n```');
    expect(r.taskType).toBe('bugfix');
  });

  it('repairs trailing commas', async () => {
    const { parseDraftResponse } = await import('./draftAnalyzer.js');
    const r = parseDraftResponse('```json\n{"taskType":"feature","relevantFiles":["a.ts",],"intentSummary":"Add the thing to the place","suggestedApproach":"do it","completionCriteria":["thing works",]}\n```');
    expect(r.taskType).toBe('feature');
    expect(r.relevantFiles).toEqual(['a.ts']);
  });

  it('anchors on relevantFiles when taskType is missing from bare JSON', async () => {
    const { parseDraftResponse } = await import('./draftAnalyzer.js');
    const r = parseDraftResponse('Analysis done. {"relevantFiles":["src/x.rs"],"intentSummary":"Wire the DSP node into the graph builder","suggestedApproach":"add to registry","completionCriteria":["node appears in graph dump"]}');
    expect(r.relevantFiles).toEqual(['src/x.rs']);
    expect(r.taskType).toBe('unknown'); // absent, but the rest is salvaged
  });

  it('salvages a markdown prose brief (the live unknown pattern)', async () => {
    const { parseDraftProse } = await import('./draftAnalyzer.js');
    const prose = [
      '## Analysis',
      'Task type: bugfix',
      'Intent: The archetype prior loader crashes on partial B2 files and loses wavetables.',
      '### Relevant files',
      '- `scripts/build_descriptor_archetypes.py`',
      '- `crates/va-osc-core/src/analog/filters/moog_ladder.rs`',
      '### Completion criteria',
      '- loader tolerates empty B2 file (unit test)',
      '- wavetable count preserved before/after',
      'Approach: guard the empty-file path and add regression tests.',
    ].join('\n');
    const r = parseDraftProse(prose);
    expect(r.taskType).toBe('bugfix');
    expect(r.relevantFiles).toContain('scripts/build_descriptor_archetypes.py');
    expect(r.completionCriteria?.length).toBeGreaterThanOrEqual(2);
  });

  it('still returns unknown for genuinely brief-less text', async () => {
    const { parseDraftProse } = await import('./draftAnalyzer.js');
    const r = parseDraftProse('I looked around the repository and it seems complicated. There are many modules.');
    expect(r.taskType).toBe('unknown');
    expect(r.relevantFiles).toEqual([]);
  });
});
