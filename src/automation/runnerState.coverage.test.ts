import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type RunnerStateModule = typeof import('./runnerState.js');

let tempHome = '';
let mod: RunnerStateModule;

async function loadFreshModule() {
  vi.resetModules();
  tempHome = mkdtempSync(join(tmpdir(), 'openswarm-runner-state-'));
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('USERPROFILE', tempHome);
  mod = await import('./runnerState.js');
}

const task = (id: string, project = 'Alpha', priority = 1, extra: Partial<any> = {}) => ({
  id,
  issueId: `${id}-issue`,
  title: `Task ${id}`,
  description: `Description ${id}`,
  priority,
  linearProject: { id: `${project}-id`, name: project },
  ...extra,
});

describe('runnerState persistence and helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-04T10:00:00.000Z'));
    await loadFreshModule();
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    mkdirSync(join(tempHome, '.openswarm'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('checks exact and child project paths', () => {
    const enabled = new Set(['/repo/app', '/repo/lib']);
    expect(mod.isPathEnabled('/repo/app', enabled)).toBe(true);
    expect(mod.isPathEnabled('/repo/app/src/index.ts', enabled)).toBe(true);
    expect(mod.isPathEnabled('/repo/application', enabled)).toBe(false);
  });

  it('records project pace, prunes old entries, and reports daily totals', async () => {
    writeFileSync(mod.DAILY_PACE_FILE, JSON.stringify({
      updatedAt: 'old',
      projects: {
        Alpha: [
          { completedAt: '2025-03-04T09:00:00.000Z', costUsd: 0.5 },
          { completedAt: '2025-03-04T02:00:00.000Z', costUsd: 0.1 },
        ],
        Beta: [{ completedAt: '2025-03-03T22:00:00.000Z' }],
      },
    }));
    vi.resetModules();
    mod = await import('./runnerState.js');
    // Cap helpers were removed with the per-project 5h cap (INT-2317) —
    // the rolling-window prune is still observable via getDailyPaceInfo.
    expect(mod.getDailyPaceInfo().projectCounts.Alpha).toBe(1);

    mod.recordProjectCompletion('Alpha', 1.25);
    const info = mod.getDailyPaceInfo();
    expect(info.completedToday).toBe(2);
    expect(info.projectCounts.Alpha).toBe(2);
    expect(info.lastCompletionAt).toBe('2025-03-04T10:00:00.000Z');
    expect(existsSync(mod.DAILY_PACE_FILE)).toBe(true);
  });

  it('loads and saves task state sets and maps', async () => {
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    writeFileSync(mod.TASK_STATE_FILE, JSON.stringify({
      completed: ['done-1'],
      failed: { bad: 2 },
      retryTimes: { bad: 12345 },
      lastFailures: { bad: { detail: 'reviewer said: missing tests', at: '2026-07-05T00:00:00.000Z' } },
    }));
    const state = {
      completedTaskIds: new Set<string>(),
      failedTaskCounts: new Map<string, number>(),
      failedTaskRetryTimes: new Map<string, number>(),
      lastFailureDetails: new Map<string, { detail: string; at: string }>(),
    };
    mod.loadTaskState(state);
    expect([...state.completedTaskIds]).toEqual(['done-1']);
    expect(state.failedTaskCounts.get('bad')).toBe(2);
    expect(state.failedTaskRetryTimes.get('bad')).toBe(12345);
    expect(state.lastFailureDetails.get('bad')?.detail).toBe('reviewer said: missing tests');

    state.completedTaskIds.add('done-2');
    state.failedTaskCounts.set('worse', 3);
    state.failedTaskRetryTimes.set('worse', 999);
    mod.recordLastFailureDetail(state, 'worse', 'reviewer said: wrong API shape');
    mod.saveTaskState(state);
    const saved = JSON.parse(readFileSync(mod.TASK_STATE_FILE, 'utf8'));
    expect(saved.completed).toContain('done-2');
    expect(saved.failed.worse).toBe(3);
    expect(saved.retryTimes.worse).toBe(999);
    expect(saved.lastFailures.worse.detail).toBe('reviewer said: wrong API shape');
  });

  it('caps recorded failure detail and ignores blank details', () => {
    const state = {
      completedTaskIds: new Set<string>(),
      failedTaskCounts: new Map<string, number>(),
      failedTaskRetryTimes: new Map<string, number>(),
      lastFailureDetails: new Map<string, { detail: string; at: string }>(),
    };
    mod.recordLastFailureDetail(state, 'big', 'x'.repeat(5000));
    expect(state.lastFailureDetails.get('big')!.detail.length).toBe(2000);
    mod.recordLastFailureDetail(state, 'blank', '   ');
    expect(state.lastFailureDetails.has('blank')).toBe(false);
  });

  it('tracks rejection entries and trims reasons', () => {
    for (let i = 1; i <= 6; i++) mod.incrementRejection('LIN-1', `reason-${i}`);
    expect(mod.getRejectionCount('LIN-1')).toBe(6);
    expect(mod.isRejectionLimitReached('LIN-1')).toBe(true);
    const entry = mod.getAllRejectionEntries()[0];
    expect(entry.reasons).toEqual(['reason-2', 'reason-3', 'reason-4', 'reason-5', 'reason-6']);
    mod.clearRejection('LIN-1');
    expect(mod.getRejectionCount('LIN-1')).toBe(0);
  });

  it('tracks decomposition state and daily creation limits', () => {
    expect(mod.getDecompositionDepth('root')).toBe(0);
    mod.registerDecomposition('root', undefined, ['child-1', 'child-2']);
    mod.registerDecomposition('child-1', 'root', ['grandchild']);
    expect(mod.getDecompositionDepth('child-1')).toBe(1);
    expect(mod.getDecompositionDepth('grandchild')).toBe(1);
    expect(mod.getChildrenCount('root')).toBe(1);
    expect(mod.getDailyCreationCount()).toBe(3);
    expect(mod.canCreateMoreIssues(4)).toBe(true);
    expect(mod.canCreateMoreIssues(3)).toBe(false);
  });

  it('keeps newest pipeline history and respects limits', () => {
    for (let i = 0; i < 105; i++) {
      mod.appendPipelineHistory({
        issueId: `issue-${i}`,
        title: `Issue ${i}`,
        projectName: 'Alpha',
        projectPath: '/repo/app',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: i % 2 ? 'failed' : 'completed',
        priority: i,
      });
    }
    const history = mod.getPipelineHistory(3);
    expect(history.map(h => h.issueId)).toEqual(['issue-104', 'issue-103', 'issue-102']);
    expect(mod.getPipelineHistory(200)).toHaveLength(100);
  });

  it('builds project dashboard info from fetched, running, queued, and cache inputs', () => {
    const fetched = [
      task('a', 'Alpha', 2),
      task('b', 'Beta', 5, { issueIdentifier: 'BET-1', linearState: 'Todo' }),
      task('r', 'Alpha', 9),
    ];
    const running = [{ task: task('r', 'Alpha', 9), projectPath: '/repo/app' }];
    const queued = [{ task: task('q', 'Gamma', 4), projectPath: '/repo/lib' }];
    const info = mod.buildProjectsInfo(fetched as any, running as any, queued as any, new Map([['Beta', '/repo/beta']]), new Set(['/repo/app']));
    const alpha = info.find(p => p.name === 'Alpha')!;
    expect(alpha.enabled).toBe(true);
    expect(alpha.running).toEqual([{ id: 'r', title: 'Task r', priority: 9 }]);
    expect(alpha.pending.map(p => p.id)).toEqual(['a']);
    const gamma = info.find(p => p.name === 'Gamma')!;
    expect(gamma.queued[0].id).toBe('q');
    expect(gamma.enabled).toBe(false);
    const beta = info.find(p => p.name === 'Beta')!;
    expect(beta.pending[0]).toMatchObject({ id: 'b', issueIdentifier: 'BET-1', linearState: 'Todo' });
  });

  it('formats retry times in friendly units', () => {
    expect(mod.formatRetryTime(Date.now() - 1)).toBe('now');
    expect(mod.formatRetryTime(Date.now() + 60_000)).toBe('in 1 minute');
    expect(mod.formatRetryTime(Date.now() + 30 * 60_000)).toBe('in 30 minutes');
    expect(mod.formatRetryTime(Date.now() + 2 * 60 * 60_000)).toBe('in 2 hours');
    expect(mod.formatRetryTime(Date.now() + (2 * 60 + 5) * 60_000)).toBe('in 2h 5m');
  });
});

describe('pickFailureDetail (INT-2504)', () => {
  it('skips junk-but-truthy details in favor of real feedback', () => {
    expect(mod.pickFailureDetail(['Unknown error', 'The cache misses tenant scope; fix and test.']))
      .toBe('The cache misses tenant scope; fix and test.');
  });

  it('prefers earlier meaningful candidates (reviewer feedback first)', () => {
    expect(mod.pickFailureDetail(['Reviewer said X', 'worker error Y'])).toBe('Reviewer said X');
  });

  it('returns undefined when everything is junk or empty', () => {
    expect(mod.pickFailureDetail(['Unknown error', '  ', undefined, 'No feedback provided'])).toBeUndefined();
  });
});
