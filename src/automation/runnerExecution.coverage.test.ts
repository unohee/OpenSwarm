// ============================================
// OpenSwarm - runnerExecution.ts coverage extension
// ============================================
//
// Targets `executePipeline` (the daemon's pipeline-execution orchestrator) plus
// the smaller exported reporting/state-sync helpers. Strategy mirrors
// `pairPipeline.coverage.test.ts`: mock every external stage/side-effect
// dependency as `vi.fn()` and drive the function through its branches.
//
// executePipeline itself never calls the real worker/reviewer/tester stages —
// it delegates to a `PairPipeline` instance built by `createPipelineFromConfig`
// and only *listens* to that instance's events (stage:start/stage:complete/
// halt/revision:start). So the key seam here is `createPipelineFromConfig`:
// we replace it with a factory that returns a plain `EventEmitter` whose `run()`
// is a controllable `vi.fn()`. Emitting synthetic events from that fake lets us
// exercise executePipeline's own listener bodies without touching the real
// (heavy) PairPipeline class or its own dependency tree.
//
// All disk/state-touching singletons (taskState/store.ts → ~/.openswarm,
// runnerState.ts → ~/.claude + ~/.openswarm, memory persistence) are mocked so
// no test touches real user state.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { EmbedBuilder } from 'discord.js';
import type { TaskItem, DecisionResult } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { DraftAnalysis } from '../agents/draftAnalyzer.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import type { ITaskSource } from './taskSource.js';
import type { ExecutionContext } from './runnerExecution.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// ---- mock fns (hoisted alongside the vi.mock() calls below) ----

const createPipelineFromConfig = vi.fn();
const runDraftAnalysis = vi.fn();
const plannerNeedsDecomposition = vi.fn();
const plannerEstimateTaskDuration = vi.fn();
const plannerRunPlanner = vi.fn();
const plannerFormatPlannerResult = vi.fn();
const buildBranchName = vi.fn();
const createWorktree = vi.fn();
const commitAndCreatePR = vi.fn();
const preserveWorktree = vi.fn();
const removeWorktree = vi.fn();
const broadcastEvent = vi.fn();
const analyzeIssue = vi.fn();
const formatWorkReport = vi.fn();
const formatReviewFeedback = vi.fn();
const formatTestReport = vi.fn();
const formatDocReport = vi.fn();
const saveCognitiveMemory = vi.fn();
const loadParsedTask = vi.fn();
const formatParsedTaskSummary = vi.fn();

const markTaskInProgress = vi.fn();
const buildTaskStateSyncComment = vi.fn();
const completeParentIfChildrenDone = vi.fn();
const markTaskBlocked = vi.fn();
const markTaskBacklog = vi.fn();
const markTaskDecomposed = vi.fn();
const markTaskDone = vi.fn();
const releaseDependentTasks = vi.fn();
const upsertTaskState = vi.fn();

const getDecompositionDepth = vi.fn();
const getChildrenCount = vi.fn();
const getDailyCreationCount = vi.fn();
const canCreateMoreIssues = vi.fn();
const registerDecomposition = vi.fn();

const loadRepoMetadata = vi.fn();
const mapLinearProject = vi.fn();
const fsStat = vi.fn();

// Only `createPipelineFromConfig` is faked; `buildTaskPrefix` is a small pure
// helper re-exported by pairPipeline.js — pull it straight from its own
// (dependency-free) source file so we never load the real (heavy) PairPipeline
// class or its transitive stage/registry/knowledge dependency tree.
vi.mock('../agents/pairPipeline.js', async () => {
  const { buildTaskPrefix } = await import('../agents/pipelineTaskPrefix.js');
  return { createPipelineFromConfig, buildTaskPrefix };
});

vi.mock('../agents/draftAnalyzer.js', () => ({ runDraftAnalysis }));

vi.mock('../support/planner.js', () => ({
  needsDecomposition: plannerNeedsDecomposition,
  estimateTaskDuration: plannerEstimateTaskDuration,
  runPlanner: plannerRunPlanner,
  formatPlannerResult: plannerFormatPlannerResult,
}));

vi.mock('../support/worktreeManager.js', () => ({
  buildBranchName,
  createWorktree,
  commitAndCreatePR,
  preserveWorktree,
  removeWorktree,
}));

vi.mock('../core/eventHub.js', () => ({ broadcastEvent }));

vi.mock('../knowledge/index.js', () => ({ analyzeIssue }));

vi.mock('../agents/worker.js', () => ({ formatWorkReport }));
vi.mock('../agents/reviewer.js', () => ({ formatReviewFeedback }));
vi.mock('../agents/tester.js', () => ({ formatTestReport }));
vi.mock('../agents/documenter.js', () => ({ formatDocReport }));

vi.mock('../memory/index.js', () => ({ saveCognitiveMemory }));
vi.mock('../orchestration/taskParser.js', () => ({ loadParsedTask, formatParsedTaskSummary }));

vi.mock('../taskState/store.js', () => ({
  markTaskInProgress,
  buildTaskStateSyncComment,
  completeParentIfChildrenDone,
  markTaskBlocked,
  markTaskBacklog,
  markTaskDecomposed,
  markTaskDone,
  releaseDependentTasks,
  upsertTaskState,
}));

vi.mock('./runnerState.js', () => ({
  getDecompositionDepth,
  getChildrenCount,
  getDailyCreationCount,
  canCreateMoreIssues,
  registerDecomposition,
}));

// resolveProjectPath / isValidProjectPath dependencies (real versions all read
// the real filesystem — openswarm.json lookups, directory scans).
vi.mock('../support/repoMetadata.js', () => ({ loadRepoMetadata }));
vi.mock('../support/projectMapper.js', () => ({ mapLinearProject }));
vi.mock('fs/promises', () => ({ stat: fsStat }));

// `./runnerExecution.js` (the module under test) must NOT be statically
// imported at the top of this file: static imports are evaluated before any
// local top-level statement, including the `const x = vi.fn()` declarations
// above — so the vi.mock() factories above would run while those consts are
// still in their temporal dead zone. Loading it lazily in `beforeAll` (which
// only runs once all top-level file code, including the consts, has executed)
// avoids that ordering trap. Mirrors the dynamic-import convention already
// used by `pairPipeline.coverage.test.ts` for the same reason.
let executePipeline: typeof import('./runnerExecution.js')['executePipeline'];
let setTaskSource: typeof import('./runnerExecution.js')['setTaskSource'];
let getTaskSource: typeof import('./runnerExecution.js')['getTaskSource'];
let setNotifier: typeof import('./runnerExecution.js')['setNotifier'];
let reportToDiscordModuleFn: typeof import('./runnerExecution.js')['reportToDiscord'];
let fetchLinearTasks: typeof import('./runnerExecution.js')['fetchLinearTasks'];
let resolveProjectPath: typeof import('./runnerExecution.js')['resolveProjectPath'];
let isValidProjectPath: typeof import('./runnerExecution.js')['isValidProjectPath'];
let reportExecutionResult: typeof import('./runnerExecution.js')['reportExecutionResult'];
let reconcileCompletionState: typeof import('./runnerExecution.js')['reconcileCompletionState'];
let syncFailureState: typeof import('./runnerExecution.js')['syncFailureState'];
let syncCancellationState: typeof import('./runnerExecution.js')['syncCancellationState'];
let syncSuccessState: typeof import('./runnerExecution.js')['syncSuccessState'];
let requestApproval: typeof import('./runnerExecution.js')['requestApproval'];

beforeAll(async () => {
  const mod = await import('./runnerExecution.js');
  executePipeline = mod.executePipeline;
  setTaskSource = mod.setTaskSource;
  getTaskSource = mod.getTaskSource;
  setNotifier = mod.setNotifier;
  reportToDiscordModuleFn = mod.reportToDiscord;
  fetchLinearTasks = mod.fetchLinearTasks;
  resolveProjectPath = mod.resolveProjectPath;
  isValidProjectPath = mod.isValidProjectPath;
  reportExecutionResult = mod.reportExecutionResult;
  reconcileCompletionState = mod.reconcileCompletionState;
  syncFailureState = mod.syncFailureState;
  syncCancellationState = mod.syncCancellationState;
  syncSuccessState = mod.syncSuccessState;
  requestApproval = mod.requestApproval;
});

// ---- fixtures & helpers ----

/** Drains the microtask queue. The pipeline event listeners registered inside
 *  executePipeline are `async` functions invoked synchronously by
 *  `EventEmitter.emit()` (which does not await them) — exactly the same
 *  fire-and-forget shape the real PairPipeline uses. To assert on a listener's
 *  side effects deterministically (instead of racing its internal awaits
 *  against our fake `run()`'s own resolution), the fake pipeline flushes with
 *  this helper right after emitting, before returning its result. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    source: 'linear',
    title: 'Fix the flaky retry logic',
    description: 'The retry logic drops cursor state between pages.',
    priority: 2,
    createdAt: Date.now(),
    issueId: 'issue-1',
    issueIdentifier: 'INT-100',
    linearProject: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

function draftAnalysisFixture(overrides: Partial<DraftAnalysis> = {}): DraftAnalysis {
  return {
    taskType: 'bugfix',
    intentSummary: 'Fix the cursor-state bug.',
    relevantFiles: ['src/a.ts'],
    suggestedApproach: 'Scope the cursor per page.',
    completionCriteria: ['Cursor state survives pagination'],
    sufficient: true,
    registrySnapshot: [],
    durationMs: 1200,
    ...overrides,
  };
}

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    success: true,
    sessionId: 'sess-1',
    stages: [],
    finalStatus: 'approved',
    totalDuration: 1000,
    iterations: 1,
    ...overrides,
  };
}

function worktreeInfoFixture(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    worktreePath: '/repo/worktree/issue-1',
    branchName: 'swarm/INT-100-fix-the-flaky-retry-logic',
    originalPath: '/repo',
    issueId: 'issue-1',
    ...overrides,
  };
}

/** A minimal EventEmitter standing in for `PairPipeline`. `run()` emits the
 *  requested events (flushing microtasks after so listener side effects are
 *  observable deterministically), then resolves with `result`. */
function makeFakePipeline(result: PipelineResult, emits: Array<[string, unknown]> = []) {
  const fp = new EventEmitter() as EventEmitter & { run: ReturnType<typeof vi.fn> };
  fp.run = vi.fn(async () => {
    for (const [event, payload] of emits) fp.emit(event, payload);
    await flush();
    return result;
  });
  return fp;
}

function makeTaskSource(overrides: Partial<ITaskSource> = {}): ITaskSource {
  return {
    kind: 'local',
    fetchTasks: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: 'top-1', identifier: 'INT-200', title: 'top' })),
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
    createSubIssue: vi.fn(async () => ({ id: 'sub-1', identifier: 'INT-101', title: 'sub-task' })),
    logPairStart: vi.fn(async () => {}),
    logPairComplete: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    unstick: vi.fn(async () => {}),
    logHalt: vi.fn(async () => {}),
    markAsDecomposed: vi.fn(async () => {}),
    ...overrides,
  } as ITaskSource;
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    allowedProjects: [],
    getRolesForProject: vi.fn(() => undefined),
    reportToDiscord: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runnerExecution.ts coverage extension', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    getDecompositionDepth.mockReturnValue(0);
    getChildrenCount.mockReturnValue(0);
    getDailyCreationCount.mockReturnValue(0);
    canCreateMoreIssues.mockReturnValue(true);
    registerDecomposition.mockReturnValue(undefined);

    markTaskInProgress.mockReturnValue({ issueId: 'issue-1' });
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    completeParentIfChildrenDone.mockReturnValue(null);
    markTaskBlocked.mockReturnValue({ issueId: 'issue-1' });
    markTaskBacklog.mockReturnValue({ issueId: 'issue-1' });
    markTaskDecomposed.mockReturnValue({ issueId: 'issue-1' });
    markTaskDone.mockReturnValue({ issueId: 'issue-1' });
    releaseDependentTasks.mockReturnValue([]);
    upsertTaskState.mockReturnValue({ issueId: 'sub-1' });

    runDraftAnalysis.mockResolvedValue(draftAnalysisFixture());
    plannerNeedsDecomposition.mockReturnValue(false);
    plannerEstimateTaskDuration.mockReturnValue(45);
    plannerFormatPlannerResult.mockReturnValue('planner result summary');

    buildBranchName.mockReturnValue('swarm/INT-100-fix-the-flaky-retry-logic');
    removeWorktree.mockResolvedValue(undefined);
    preserveWorktree.mockResolvedValue(true);
    analyzeIssue.mockResolvedValue(null);
    saveCognitiveMemory.mockResolvedValue(undefined);
    loadParsedTask.mockResolvedValue(null);
    formatParsedTaskSummary.mockReturnValue('parsed summary');

    formatWorkReport.mockReturnValue('work report');
    formatReviewFeedback.mockReturnValue('review feedback');
    formatTestReport.mockReturnValue('test report');
    formatDocReport.mockReturnValue('doc report');

    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ============================================
  // Draft analysis
  // ============================================

  describe('draft analysis', () => {
    it('runs draft analysis by default, then proceeds to the pipeline (happy path)', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(runDraftAnalysis).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('skips draft analysis when enableDraftAnalysis is false', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx({ enableDraftAnalysis: false }), task(), '/repo');

      expect(runDraftAnalysis).not.toHaveBeenCalled();
    });

    it('returns a rate_limited result immediately when draft analysis hits a rate limit', async () => {
      runDraftAnalysis.mockRejectedValueOnce(new RateLimitError(1782824950, 'Codex usage limit reached'));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(result.finalStatus).toBe('rate_limited');
      expect(result.success).toBe(false);
      expect(result.rateLimitResetsAt).toBe(1782824950 * 1000);
      // The pipeline must never be constructed for a pre-pipeline rate limit.
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });

    it('treats a non-rate-limit draft analysis failure as non-blocking and continues', async () => {
      runDraftAnalysis.mockRejectedValueOnce(new Error('draft analyzer crashed'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Draft analysis failed'),
        expect.any(Error),
      );
    });

    it('mirrors draft analysis onLog lines to stdout and the event hub', async () => {
      runDraftAnalysis.mockImplementationOnce(async (opts: { onLog: (line: string) => void }) => {
        opts.onLog('scanning repository...');
        return draftAnalysisFixture();
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('scanning repository...'));
      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        data: expect.objectContaining({ stage: 'draft', line: 'scanning repository...' }),
      }));
    });

    it('propagates a non-rate-limit error thrown by the decomposition heuristic instead of swallowing it', async () => {
      // planner.needsDecomposition() runs synchronously inside the same
      // try/catch that classifies RateLimitError vs everything else — a plain
      // Error here must be rethrown to the caller (line ~747), not converted
      // into a rate_limited result.
      plannerNeedsDecomposition.mockImplementationOnce(() => {
        throw new Error('heuristic crashed');
      });

      await expect(executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      )).rejects.toThrow('heuristic crashed');
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Decomposition
  // ============================================

  describe('decomposition', () => {
    it('skips decomposition entirely when the heuristic says it is not needed', async () => {
      plannerNeedsDecomposition.mockReturnValue(false);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(plannerRunPlanner).not.toHaveBeenCalled();
    });

    it('falls through to direct execution when the daily creation limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      canCreateMoreIssues.mockReturnValue(false);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      // Daily-limit short-circuit happens before the planner is ever invoked.
      expect(plannerRunPlanner).not.toHaveBeenCalled();
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('falls through to direct execution when the planner says the task fits the threshold', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: false,
        subTasks: [],
        totalEstimatedMinutes: 0,
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('falls through to direct execution when the planner itself fails', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: false,
        originalIssue: 'issue-1',
        needsDecomposition: false,
        subTasks: [],
        totalEstimatedMinutes: 0,
        error: 'planner adapter exploded',
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('returns a decomposed result and creates sub-issues when the planner recommends decomposition', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'do the first part', estimatedMinutes: 20, priority: 2, fileScope: ['src/a.ts', '  ', 42 as unknown as string] },
          { title: 'Sub 2', description: 'do the second part', estimatedMinutes: 15, priority: 3, dependencies: ['Sub 1'] },
        ],
        totalEstimatedMinutes: 35,
      });
      // Echo back a per-call unique id/title (matching the real ITaskSource
      // contract) so the dependency-resolution map (childIdByTitle) actually
      // resolves Sub 2's dependency on "Sub 1" — the shared taskSourceMock
      // default (a single fixed return value for every call) would otherwise
      // make every sub-issue resolve to the same title/id, masking the
      // blocked-dependency branch entirely.
      let subCounter = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `sub-${++subCounter}`, identifier: `INT-10${subCounter}`, title }),
      );
      const scheduleNextHeartbeat = vi.fn();

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, scheduleNextHeartbeat }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('decomposed');
      expect(result.success).toBe(true);
      // The real pipeline must never run for a successfully decomposed task.
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
      expect(registerDecomposition).toHaveBeenCalledWith('issue-1', undefined, ['sub-1', 'sub-2']);
      expect(markTaskDecomposed).toHaveBeenCalled();
      expect(scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
      // Sub 1 has no dependencies → moved straight to Todo; Sub 2 depends on
      // Sub 1 (now resolvable via the per-call id) → kept in Backlog.
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('sub-1', 'Todo');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Keeping INT-102 in Backlog until dependencies resolve'));
    });

    it('tolerates a failure initializing one sub-issue state without aborting the rest', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 10, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 10, priority: 2 },
        ],
        totalEstimatedMinutes: 20,
      });
      let subCounter = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `sub-${++subCounter}`, identifier: `INT-10${subCounter}`, title }),
      );
      (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('decomposed');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize'), expect.any(Error));
      // Both sub-issues were still created despite the first one's state-init failing.
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
    });

    it('auto-moves the task to Backlog and skips decomposition once the depth limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(2); // == default maxDepth
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved'); // falls through to direct execution
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('issue-1', 'Backlog');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.stringContaining('depth limit'));
      expect(plannerRunPlanner).not.toHaveBeenCalled();
    });

    it('tolerates a failure while auto-backlogging on depth-limit', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(5);
      (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await expect(executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to move to backlog'), expect.any(Error));
    });

    it('auto-moves the task to Backlog and skips decomposition once the children-count limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getChildrenCount.mockReturnValue(5); // == default maxChildren
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.stringContaining('too many sub-issues'));
    });

    it('does not auto-backlog on limit breach when decompositionAutoBacklog is disabled', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(9);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionAutoBacklog: false }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.updateState).not.toHaveBeenCalledWith('issue-1', 'Backlog');
    });

    it('falls through to direct execution when the task has no issueId to attach sub-issues to', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: '', needsDecomposition: true,
        subTasks: [{ title: 'Sub 1', description: 'd', estimatedMinutes: 10, priority: 2 }],
        totalEstimatedMinutes: 10,
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task({ issueId: undefined, issueIdentifier: undefined }),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
    });

    it('reports zero created sub-issues as a decompose failure and falls back to direct execution', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: 'issue-1', needsDecomposition: true,
        subTasks: [{ title: 'Sub 1', description: 'd', estimatedMinutes: 10, priority: 2 }],
        totalEstimatedMinutes: 10,
      });
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'Linear rejected the sub-issue' });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved'); // decomposeTask returned false → direct execution
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No sub-issues created'));
    });

    it('surfaces the planner onLog stream and tolerates a KG impact-analysis failure', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      analyzeIssue.mockRejectedValueOnce(new Error('graph unavailable'));
      plannerRunPlanner.mockImplementationOnce(async (opts: { onLog: (line: string) => void }) => {
        opts.onLog('planner iterating...');
        return {
          success: true, originalIssue: 'issue-1', needsDecomposition: false, subTasks: [], totalEstimatedMinutes: 0,
        };
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        data: expect.objectContaining({ stage: 'decompose', line: 'planner iterating...' }),
      }));
    });
  });

  // ============================================
  // Worktree mode
  // ============================================

  describe('worktree mode', () => {
    it('creates a worktree, runs the pipeline, and opens a PR on approval', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      commitAndCreatePR.mockResolvedValue('https://github.com/org/repo/pull/1');
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult({ finalStatus: 'approved', success: true })));

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(createWorktree).toHaveBeenCalledWith('/repo', 'issue-1', 'swarm/INT-100-fix-the-flaky-retry-logic');
      expect(commitAndCreatePR).toHaveBeenCalledTimes(1);
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(preserveWorktree).not.toHaveBeenCalled();
    });

    it('returns infra_error without ever constructing the pipeline when worktree creation fails', async () => {
      createWorktree.mockRejectedValue(new Error('git worktree add: disk full'));

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.finalStatus).toBe('infra_error');
      expect(result.success).toBe(false);
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });

    it('preserves the worktree when the pipeline result is not successful', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      createPipelineFromConfig.mockReturnValue(
        makeFakePipeline(pipelineResult({ success: false, finalStatus: 'rejected' })),
      );

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(false);
      expect(preserveWorktree).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'issue-1' }), 'session did not succeed');
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('logs an unexpected-state reason and still removes the worktree when success is true but finalStatus is not approved', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      createPipelineFromConfig.mockReturnValue(
        makeFakePipeline(pipelineResult({ success: true, finalStatus: 'cancelled' })),
      );

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(true);
      expect(commitAndCreatePR).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unexpected state'));
      expect(removeWorktree).toHaveBeenCalledTimes(1);
    });

    it('tolerates a PR-creation failure (logs it, keeps the run a success)', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      commitAndCreatePR.mockRejectedValue(new Error('gh pr create failed'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(true);
      expect(result.prUrl).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith('[Worktree] PR creation failed:', expect.any(Error));
      expect(removeWorktree).toHaveBeenCalledTimes(1);
    });

    it('tolerates a worktree cleanup failure without throwing', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      removeWorktree.mockRejectedValueOnce(new Error('rm -rf failed: EBUSY'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await expect(executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo')).resolves.toBeDefined();
      expect(console.warn).toHaveBeenCalledWith('[Worktree] Cleanup failed:', expect.any(Error));
    });
  });

  // ============================================
  // Pipeline event handlers
  // ============================================

  describe('pipeline event handlers', () => {
    it('posts a worker-start audit comment only for the worker stage on a task with an issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', {
          stage: 'worker',
          context: { currentIteration: 1, config: { roles: { worker: { model: 'worker-model', maxTurns: 8 } } } },
          model: 'worker-model',
        }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.any(String));
    });

    it('does not post a worker-start audit comment when the task has no issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', { stage: 'worker', context: { currentIteration: 1 }, model: undefined }],
      ]));

      await executePipeline(makeCtx(), task({ issueId: undefined, issueIdentifier: undefined }), '/repo');

      expect(taskSourceMock.addComment).not.toHaveBeenCalled();
    });

    it('tolerates a worker-start audit comment failure', async () => {
      // First addComment() call is the "Task execution started" sync comment
      // posted before the pipeline runs; the SECOND call is the worker-start
      // audit comment fired (fire-and-forget) from the stage:start listener.
      (taskSourceMock.addComment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('linear API down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', {
          stage: 'worker',
          context: { currentIteration: 1, config: { roles: { worker: { model: 'worker-model' } } } },
          model: 'worker-model',
        }],
      ]));

      await expect(executePipeline(makeCtx(), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker start audit comment failed'), expect.any(Error));
    });

    it('includes tester and documenter in the Stages field when those roles are enabled', async () => {
      const getRolesForProject = vi.fn(() => ({
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        tester: { enabled: true, timeoutMs: 0 },
        documenter: { enabled: true, timeoutMs: 0 },
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ getRolesForProject, reportToDiscord }), task(), '/repo');

      const startEmbed = reportToDiscord.mock.calls
        .map((c) => c[0])
        .find((m): m is EmbedBuilder => m instanceof EmbedBuilder);
      const stagesField = (startEmbed as EmbedBuilder).data.fields?.find((f) => f.name === 'Stages');
      expect(stagesField?.value).toBe('worker → reviewer → tester → documenter');
    });

    it('includes the deterministic tester stage when verify is enabled independently of the tester role', async () => {
      const getRolesForProject = vi.fn(() => ({
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        tester: { enabled: false, timeoutMs: 0 },
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({
        getRolesForProject,
        reportToDiscord,
        verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
      }), task(), '/repo');

      expect(createPipelineFromConfig.mock.calls[0][7]).toMatchObject({ enabled: true });
      const startEmbed = reportToDiscord.mock.calls
        .map((c) => c[0])
        .find((m): m is EmbedBuilder => m instanceof EmbedBuilder);
      const stagesField = (startEmbed as EmbedBuilder).data.fields?.find((f) => f.name === 'Stages');
      expect(stagesField?.value).toBe('worker → reviewer → tester');
    });

    it('falls back to the directory basename for the pipeline metadata repository name when the task has no Linear project', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task({ linearProject: undefined }), '/repo/OpenSwarm');

      // createPipelineFromConfig's 7th argument is the PipelineRunMetadata built
      // by the (unexported) pipelineMetadata() helper — its `repository` field
      // falls back to repoNameFromPath(projectPath) when there is no Linear
      // project name to use.
      const runMetadata = createPipelineFromConfig.mock.calls[0][6];
      expect(runMetadata).toEqual(expect.objectContaining({ repository: 'OpenSwarm' }));
    });

    it('reports the worker stage result and posts a worker-complete audit comment', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'worker',
          result: {
            success: true,
            duration: 4000,
            result: {
              success: true, summary: 'done', filesChanged: ['a.ts'], commands: [], output: '', confidencePercent: 90,
            },
          },
          context: { currentIteration: 1 },
        }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(formatWorkReport).toHaveBeenCalled();
      expect(reportToDiscord).toHaveBeenCalledWith('work report');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.any(String));
    });

    it('tolerates a worker-complete audit comment failure', async () => {
      // The first addComment() call is the "Task execution started" sync
      // comment posted before the pipeline runs; only the second call (the
      // worker-complete audit comment, posted from the stage:complete
      // listener under test) should fail.
      (taskSourceMock.addComment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('linear API down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'worker',
          result: {
            success: true,
            duration: 1000,
            result: { success: true, summary: 'done', filesChanged: [], commands: [], output: '', confidencePercent: 80 },
          },
          context: { currentIteration: 1 },
        }],
      ]));

      await expect(executePipeline(makeCtx(), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker complete audit comment failed'), expect.any(Error));
    });

    it('files reviewer follow-ups when autoFileFollowups is enabled and the reviewer approved', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'reviewer',
          result: {
            success: true,
            result: {
              decision: 'approve',
              feedback: 'lgtm',
              recommendedActions: [{ type: 'test', title: 'add edge-case coverage' }],
            },
          },
          context: {},
        }],
      ]));

      await executePipeline(
        makeCtx({ guards: { autoFileFollowups: true } }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.createSubIssue).toHaveBeenCalledWith(
        'issue-1',
        '[test] add edge-case coverage',
        expect.any(String),
        expect.objectContaining({ priority: 3 }),
      );
    });

    it('does not file follow-ups when autoFileFollowups is disabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'reviewer',
          result: { success: true, result: { decision: 'approve', feedback: 'lgtm', recommendedActions: [{ type: 'test', title: 'x' }] } },
          context: {},
        }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
    });

    it('reports tester and documenter stage results via their dynamic-import branches', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', { stage: 'tester', result: { success: true, result: { success: true, testsPassed: 1, testsFailed: 0, output: 'PASS' } }, context: {} }],
        ['stage:complete', { stage: 'documenter', result: { success: true, result: { success: true, updatedFiles: [], apiDocsUpdated: false, summary: 'ok' } }, context: {} }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(formatTestReport).toHaveBeenCalled();
      expect(formatDocReport).toHaveBeenCalled();
      expect(reportToDiscord).toHaveBeenCalledWith('test report');
      expect(reportToDiscord).toHaveBeenCalledWith('doc report');
    });

    it('reports a revision:start event to Discord', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['revision:start', { stage: 'worker' }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(reportToDiscord).toHaveBeenCalledWith(expect.stringContaining('Revision needed'));
    });

    it('logs a halt to Linear and reports an embed when haltToLinear is enabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 35, haltReason: 'uncertain about the edge case', sessionId: 'sess-9', iteration: 2 }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(
        makeCtx({ guards: { haltToLinear: true }, reportToDiscord }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.logHalt).toHaveBeenCalledWith('issue-1', 'sess-9', 35, 2, 'uncertain about the edge case');
      const embedCall = reportToDiscord.mock.calls.find((c) => c[0] instanceof EmbedBuilder);
      expect(embedCall).toBeDefined();
    });

    it('does not log halt to Linear when haltToLinear is disabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 35, haltReason: 'uncertain', sessionId: 'sess-9', iteration: 2 }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.logHalt).not.toHaveBeenCalled();
    });

    it('tolerates a logHalt failure', async () => {
      (taskSourceMock.logHalt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 20, haltReason: 'very uncertain', sessionId: 'sess-1', iteration: 1 }],
      ]));

      await expect(executePipeline(
        makeCtx({ guards: { haltToLinear: true } }),
        task(),
        '/repo',
      )).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Linear logHalt failed'), expect.any(Error));
    });
  });

  // ============================================
  // Task-state bookkeeping at pipeline start
  // ============================================

  describe('task state bookkeeping at start', () => {
    it('marks the task in-progress and logs pair-start when the task has an issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(markTaskInProgress).toHaveBeenCalled();
      expect(taskSourceMock.logPairStart).toHaveBeenCalledWith('issue-1', expect.any(String), '/repo');
    });

    it('falls back to updateState when logPairStart throws', async () => {
      (taskSourceMock.logPairStart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.updateState).toHaveBeenCalledWith('issue-1', 'In Progress');
    });

    it('skips the in-progress bookkeeping entirely when the task has no issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task({ issueId: undefined, issueIdentifier: undefined }), '/repo');

      expect(markTaskInProgress).not.toHaveBeenCalled();
      expect(taskSourceMock.logPairStart).not.toHaveBeenCalled();
    });
  });
});

// ============================================
// Other exported helpers (reporting / state sync)
// ============================================

describe('reportExecutionResult', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    saveCognitiveMemory.mockResolvedValue(undefined);
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function executorResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
    return {
      success: true,
      duration: 5000,
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'completed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'completed', startedAt: Date.now() },
        },
      },
      ...overrides,
    };
  }

  it('reports success and saves a cognitive-memory strategy entry', async () => {
    const reportFn = vi.fn(async () => {});

    await reportExecutionResult(task(), executorResult(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(saveCognitiveMemory).toHaveBeenCalledWith(
      'strategy',
      expect.stringContaining('succeeded'),
      expect.objectContaining({ derivedFrom: 'issue-1' }),
    );
  });

  it('tolerates a memory-save failure on success', async () => {
    saveCognitiveMemory.mockRejectedValueOnce(new Error('memory store full'));
    const reportFn = vi.fn(async () => {});

    await expect(reportExecutionResult(task(), executorResult(), reportFn)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Memory save failed'), expect.any(Error));
  });

  it('reports failure with the failed step error as a follow-up message', async () => {
    const reportFn = vi.fn(async () => {});
    const result = executorResult({
      success: false,
      failedStep: 'step1',
      rollbackPerformed: true,
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'failed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'failed', startedAt: Date.now(), error: 'boom: assertion failed' },
        },
      },
    });

    await reportExecutionResult(task(), result, reportFn);

    expect(reportFn).toHaveBeenCalledTimes(2);
    expect(reportFn.mock.calls[1][0]).toEqual(expect.stringContaining('boom: assertion failed'));
    expect(saveCognitiveMemory).not.toHaveBeenCalled();
  });

  it('reports failure without a second message when there is no captured error', async () => {
    const reportFn = vi.fn(async () => {});
    const result = executorResult({
      success: false,
      failedStep: 'step1',
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'failed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'failed', startedAt: Date.now() },
        },
      },
    });

    await reportExecutionResult(task(), result, reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
  });
});

describe('requestApproval', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    loadParsedTask.mockResolvedValue(null);
    formatParsedTaskSummary.mockReturnValue('parsed summary');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function decision(overrides: Partial<DecisionResult> = {}): DecisionResult {
    return {
      action: 'execute',
      reason: 'High priority and unblocked.',
      task: task(),
      ...overrides,
    };
  }

  it('does nothing when the decision has no task', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision({ task: undefined }), reportFn);

    expect(reportFn).not.toHaveBeenCalled();
  });

  it('reports only the embed when the task has no parsed-task summary on disk', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(reportFn.mock.calls[0][0]).toBeInstanceOf(EmbedBuilder);
  });

  it('reports the embed plus a parsed-task summary block when one exists', async () => {
    loadParsedTask.mockResolvedValueOnce({
      analysis: { type: 'bugfix', complexity: 'low', estimatedSteps: 2, risks: [] },
    });
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(2);
    expect(reportFn.mock.calls[1][0]).toEqual(expect.stringContaining('parsed summary'));
  });

  it('skips the parsed-task lookup when the task has no issueId', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision({ task: task({ issueId: undefined }) }), reportFn);

    expect(loadParsedTask).not.toHaveBeenCalled();
    expect(reportFn).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileCompletionState', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    releaseDependentTasks.mockReturnValue([]);
    completeParentIfChildrenDone.mockReturnValue(null);
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does nothing when the task has no issueId', async () => {
    await reconcileCompletionState(task({ issueId: undefined }));

    expect(releaseDependentTasks).not.toHaveBeenCalled();
  });

  it('releases dependent tasks back to Todo', async () => {
    releaseDependentTasks.mockReturnValueOnce([{ issueId: 'child-1' }, { issueId: 'child-2' }]);

    await reconcileCompletionState(task());

    expect(taskSourceMock.updateState).toHaveBeenCalledWith('child-1', 'Todo');
    expect(taskSourceMock.updateState).toHaveBeenCalledWith('child-2', 'Todo');
    expect(taskSourceMock.addComment).toHaveBeenCalledTimes(2);
  });

  it('tolerates a release failure for one child without stopping the others', async () => {
    releaseDependentTasks.mockReturnValueOnce([{ issueId: 'child-1' }, { issueId: 'child-2' }]);
    (taskSourceMock.updateState as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('linear down'))
      .mockResolvedValueOnce(true);

    await reconcileCompletionState(task());

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release dependent task'), expect.any(Error));
    expect(taskSourceMock.updateState).toHaveBeenCalledTimes(2);
  });

  it('marks the parent Done when all children have completed', async () => {
    completeParentIfChildrenDone.mockReturnValueOnce({ issueId: 'parent-1' });

    await reconcileCompletionState(task());

    expect(taskSourceMock.updateState).toHaveBeenCalledWith('parent-1', 'Done');
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('parent-1', 'sync comment');
  });

  it('tolerates a parent-completion update failure', async () => {
    completeParentIfChildrenDone.mockReturnValueOnce({ issueId: 'parent-1' });
    (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await expect(reconcileCompletionState(task())).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to complete parent task'), expect.any(Error));
  });
});

describe('syncFailureState / syncCancellationState / syncSuccessState', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    markTaskBlocked.mockReturnValue({ issueId: 'issue-1' });
    markTaskBacklog.mockReturnValue({ issueId: 'issue-1' });
    markTaskDone.mockReturnValue({ issueId: 'issue-1' });
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('syncFailureState no-ops without an issueId', async () => {
    await syncFailureState(task({ issueId: undefined }), 'blocked reason');
    expect(markTaskBlocked).not.toHaveBeenCalled();
  });

  it('syncFailureState marks the task blocked and comments', async () => {
    await syncFailureState(task({ blockedBy: ['dep-1'] }), 'blocked reason');

    expect(markTaskBlocked).toHaveBeenCalledWith('issue-1', 'blocked reason', ['dep-1'], undefined);
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncFailureState tolerates an addComment failure', async () => {
    (taskSourceMock.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await expect(syncFailureState(task(), 'blocked reason')).resolves.toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync blocked state'), expect.any(Error));
  });

  it('syncCancellationState no-ops without an issueId', async () => {
    await syncCancellationState(task({ issueId: undefined }));
    expect(markTaskBacklog).not.toHaveBeenCalled();
  });

  it('syncCancellationState moves the task to Backlog and comments', async () => {
    await syncCancellationState(task());

    expect(taskSourceMock.updateState).toHaveBeenCalledWith('issue-1', 'Backlog');
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncCancellationState tolerates an updateState failure and still tries the comment', async () => {
    (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await syncCancellationState(task());

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to move cancelled task'), expect.any(Error));
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncCancellationState tolerates an addComment failure', async () => {
    (taskSourceMock.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await expect(syncCancellationState(task())).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync cancelled state'), expect.any(Error));
  });

  it('syncSuccessState no-ops without an issueId', async () => {
    await syncSuccessState(task({ issueId: undefined }), 90);
    expect(markTaskDone).not.toHaveBeenCalled();
  });

  it('syncSuccessState marks the task done and comments with confidence', async () => {
    await syncSuccessState(task(), 92);

    expect(markTaskDone).toHaveBeenCalledWith('issue-1', expect.objectContaining({ confidence: 92 }));
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncSuccessState tolerates an addComment failure', async () => {
    (taskSourceMock.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await expect(syncSuccessState(task(), 92)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync success state'), expect.any(Error));
  });
});

// ============================================
// setNotifier / reportToDiscord (module-level notifier singleton)
// ============================================
//
// NOTE on ordering: the `notifier` module singleton has no public reset — once
// `setNotifier()` is called it stays set for the rest of this test file. These
// two tests must run in this order (the default, since vitest runs `it`s
// within a describe sequentially): "no notifier registered" first, then
// "registers a notifier". No other describe in this file calls setNotifier.
describe('setNotifier / reportToDiscord (module notifier singleton)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs instead of notifying when no notifier has been registered yet', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await reportToDiscordModuleFn('hello from OpenSwarm');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No notifier'), 'hello from OpenSwarm');
  });

  it('registers a notifier and routes subsequent messages through it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const notify = vi.fn(async () => {});

    setNotifier({ notify });
    await reportToDiscordModuleFn('now routed');

    expect(notify).toHaveBeenCalledWith('now routed');
  });
});

// ============================================
// getTaskSource / fetchLinearTasks
// ============================================

describe('getTaskSource / fetchLinearTasks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('getTaskSource returns the currently registered task source', () => {
    const src = makeTaskSource();
    setTaskSource(src);

    expect(getTaskSource()).toBe(src);
  });

  it('fetchLinearTasks returns tasks from the registered source', async () => {
    const tasks = [task()];
    setTaskSource(makeTaskSource({ fetchTasks: vi.fn(async () => tasks) }));

    const result = await fetchLinearTasks();

    expect(result.tasks).toBe(tasks);
    expect(result.error).toBeUndefined();
  });

  it('fetchLinearTasks surfaces a fetch failure as an error string, and logs recovery on the next success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchTasks = vi.fn()
      .mockRejectedValueOnce(new Error('linear API down'))
      .mockResolvedValueOnce([]);
    setTaskSource(makeTaskSource({ fetchTasks }));

    const failed = await fetchLinearTasks();
    expect(failed.tasks).toEqual([]);
    expect(failed.error).toBe('linear API down');

    const recovered = await fetchLinearTasks();
    expect(recovered.error).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('recovered after 1 failures'));
  });
});

// ============================================
// resolveProjectPath / isValidProjectPath
// ============================================
//
// These use the real priority ladder (openswarm.json mapping → allowedProjects
// basename → ~/dev/{name} → ~/dev/{name.toLowerCase()} → ~/dev/tools/{name} →
// fuzzy projectMapper), with `fs/promises`, repoMetadata.js, and
// projectMapper.js all mocked so no test touches the real filesystem or $HOME.

describe('resolveProjectPath / isValidProjectPath', () => {
  /** Builds an `fs.stat` implementation: `dirs` maps a directory path to the
   *  marker files (e.g. '.git') that exist directly under it. Any other path
   *  rejects with ENOENT, matching real fs.stat behavior for a missing path. */
  function makeFsStatImpl(dirs: Record<string, string[]>) {
    return async (p: string) => {
      const norm = String(p);
      if (norm in dirs) return { isDirectory: () => true, isFile: () => false };
      for (const [dir, markers] of Object.entries(dirs)) {
        if (markers.some((m) => norm === `${dir}/${m}`)) return { isDirectory: () => false, isFile: () => true };
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${norm}'`), { code: 'ENOENT' });
    };
  }

  let originalHome: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    originalHome = process.env.HOME;
    process.env.HOME = '/home/testuser';
    loadRepoMetadata.mockReset();
    mapLinearProject.mockReset();
    fsStat.mockReset();
    // Default: nothing exists anywhere (every priority falls through).
    fsStat.mockImplementation(makeFsStatImpl({}));
    loadRepoMetadata.mockResolvedValue(null);
    mapLinearProject.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns null immediately when the task has no Linear project info', async () => {
    const result = await resolveProjectPath(makeCtx(), task({ linearProject: undefined }));

    expect(result).toBeNull();
    expect(loadRepoMetadata).not.toHaveBeenCalled();
  });

  it('resolves via the openswarm.json mapping when a repo declares this Linear project', async () => {
    loadRepoMetadata.mockResolvedValueOnce({ linear: { projectId: 'proj-1' } });
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/repoA': ['.git'] }));
    const ctx = makeCtx({ allowedProjects: ['/home/dev/repoA'] });

    const result = await resolveProjectPath(ctx, task({ linearProject: { id: 'proj-1', name: 'OpenSwarm' } }));

    expect(result).toBe('/home/dev/repoA');
  });

  it('tolerates an unreadable openswarm.json and falls through to the next priority', async () => {
    loadRepoMetadata.mockRejectedValueOnce(new Error('EACCES'));
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/OpenSwarm': ['.git'] }));
    const ctx = makeCtx({ allowedProjects: ['/home/dev/OpenSwarm'] });

    const result = await resolveProjectPath(ctx, task({ linearProject: { id: 'proj-1', name: 'OpenSwarm' } }));

    expect(result).toBe('/home/dev/OpenSwarm');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('openswarm.json unreadable'));
  });

  it('falls through to an exact (case-insensitive) basename match in allowedProjects', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/openswarm-repo': ['package.json'] }));
    const ctx = makeCtx({ allowedProjects: ['/home/dev/openswarm-repo'] });

    const result = await resolveProjectPath(
      ctx,
      task({ linearProject: { id: 'proj-1', name: 'openswarm-repo' } }),
    );

    expect(result).toBe('/home/dev/openswarm-repo');
  });

  it('falls through to the direct ~/dev/{name} path', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/home/testuser/dev/OpenSwarm': ['.git'] }));

    const result = await resolveProjectPath(makeCtx(), task({ linearProject: { id: 'proj-1', name: 'OpenSwarm' } }));

    expect(result).toBe('/home/testuser/dev/OpenSwarm');
  });

  it('falls through to the lowercase ~/dev/{name} path when the exact-case path does not exist', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/home/testuser/dev/openswarm': ['.git'] }));

    const result = await resolveProjectPath(makeCtx(), task({ linearProject: { id: 'proj-1', name: 'OpenSwarm' } }));

    expect(result).toBe('/home/testuser/dev/openswarm');
  });

  it('falls through to the ~/dev/tools/{name} path', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/home/testuser/dev/tools/pykis': ['pyproject.toml'] }));

    const result = await resolveProjectPath(makeCtx(), task({ linearProject: { id: 'proj-1', name: 'pykis' } }));

    expect(result).toBe('/home/testuser/dev/tools/pykis');
  });

  it('falls through to the fuzzy projectMapper match as a last resort', async () => {
    mapLinearProject.mockResolvedValueOnce('/some/fuzzy/match');

    const result = await resolveProjectPath(makeCtx(), task({ linearProject: { id: 'proj-1', name: 'Unmatched Project' } }));

    expect(result).toBe('/some/fuzzy/match');
    expect(mapLinearProject).toHaveBeenCalledWith('proj-1', 'Unmatched Project', []);
  });

  it('returns null when every priority fails to resolve a path', async () => {
    const result = await resolveProjectPath(makeCtx(), task({ linearProject: { id: 'proj-1', name: 'Nowhere' } }));

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve project path'));
  });

  it('isValidProjectPath returns false for a path that is not a directory', async () => {
    fsStat.mockImplementation(async () => ({ isDirectory: () => false }));

    await expect(isValidProjectPath('/some/file.txt')).resolves.toBe(false);
  });

  it('isValidProjectPath returns false when fs.stat throws (path does not exist)', async () => {
    fsStat.mockImplementation(async () => { throw new Error('ENOENT'); });

    await expect(isValidProjectPath('/does/not/exist')).resolves.toBe(false);
  });

  it('isValidProjectPath returns true on the second marker check when the first marker is absent', async () => {
    // '.git' is absent but 'package.json' exists — exercises the loop's
    // continue-then-succeed path.
    fsStat.mockImplementation(makeFsStatImpl({ '/repo/node-project': ['package.json'] }));

    await expect(isValidProjectPath('/repo/node-project')).resolves.toBe(true);
  });

  it('isValidProjectPath returns false when the directory has none of the marker files', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/repo/empty-dir': [] }));

    await expect(isValidProjectPath('/repo/empty-dir')).resolves.toBe(false);
  });
});
