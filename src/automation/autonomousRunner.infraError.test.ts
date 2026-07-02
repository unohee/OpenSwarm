import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { ITaskSource } from './taskSource.js';

// Regression for INT-2010: adapter CLI/infra failures (the worker/reviewer never
// ran) must NOT drive a completable issue to durable STUCK. They get a backoff
// retry, like rate limits — not a logStuck.

type AutonomousRunnerCtor = typeof import('./autonomousRunner.js').AutonomousRunner;
type RunnerExecutionModule = typeof import('./runnerExecution.js');

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
let runnerExecution: RunnerExecutionModule;

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  maxConsecutiveTasks: 1,
  cooldownSeconds: 0,
  dryRun: true,
  ...over,
});

const task = (): TaskItem => ({
  id: 'task-1',
  source: 'linear',
  issueId: 'ISSUE-1',
  issueIdentifier: 'INT-1',
  title: 'Edit some files',
  priority: 3,
  createdAt: Date.now(),
});

const result = (finalStatus: PipelineResult['finalStatus']): PipelineResult => ({
  success: false,
  sessionId: 'pipeline-1',
  iterations: 0,
  totalDuration: 5,
  finalStatus,
  stages: [],
  workerResult: { success: false, summary: '', filesChanged: [], commands: [], output: '', error: 'codex CLI failed with code 1' },
});

function mockTaskSource() {
  return {
    kind: 'local',
    updateState: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
  } as unknown as ITaskSource & {
    updateState: ReturnType<typeof vi.fn>;
    logStuck: ReturnType<typeof vi.fn>;
  };
}

async function runN(scheduler: TaskScheduler, finalStatus: PipelineResult['finalStatus'], n: number) {
  for (let i = 0; i < n; i++) {
    scheduler.startTask(task(), '/repo', async () => result(finalStatus));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('AutonomousRunner infra_error handling (INT-2010)', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'openswarm-infra-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(tempDir, 'task-state.json'));
    ({ AutonomousRunner } = await import('./autonomousRunner.js'));
    runnerExecution = await import('./runnerExecution.js');
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('never marks STUCK even after many infra_error runs', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'infra_error', 6); // well past MAX_RETRY_COUNT (4)

    expect(source.logStuck).not.toHaveBeenCalled();
    expect(source.updateState).not.toHaveBeenCalled(); // no failure-state sync
  });

  it('still marks STUCK after MAX_RETRY_COUNT genuine failures (control)', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'failed', 4);

    expect(source.logStuck).toHaveBeenCalled();
  });
});
