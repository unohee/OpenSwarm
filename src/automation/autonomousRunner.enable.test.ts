// Purpose: enableProject must also add the repo to allowedProjects so
// resolveProjectPath reads its openswarm.json mapping (INT-1973).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AutonomousRunner, decisionSelectionBudget } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/x/a'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  maxConsecutiveTasks: 1,
  cooldownSeconds: 0,
  dryRun: true,
  ...over,
});

describe('AutonomousRunner.enableProject (INT-1973)', () => {
  it('enabling a repo also allows it (resolveProjectPath reads only allowed paths)', () => {
    const r = new AutonomousRunner(cfg());
    r.enableProject('/x/wave');
    expect(r.getEnabledProjects()).toContain('/x/wave');
    expect(r.getAllowedProjects()).toContain('/x/wave');
  });

  it('does not duplicate an already-allowed path', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(r.getAllowedProjects().filter((p) => p === '/x/a')).toHaveLength(1);
    expect(r.getEnabledProjects()).toContain('/x/a');
  });
});

describe('decisionSelectionBudget', () => {
  it('oversamples candidates so post-selection skips do not leave slots idle', () => {
    expect(decisionSelectionBudget(3, 50)).toBe(9);
    expect(decisionSelectionBudget(6, 50)).toBe(18);
  });

  it('never exceeds available candidates and handles empty inputs', () => {
    expect(decisionSelectionBudget(6, 4)).toBe(4);
    expect(decisionSelectionBudget(0, 10)).toBe(0);
    expect(decisionSelectionBudget(3, 0)).toBe(0);
  });
});

describe('AutonomousRunner project-selection gating (INT-2207)', () => {
  // shouldFilterByEnabled is private; the gating behavior is what matters.
  type Internal = { shouldFilterByEnabled(): boolean };
  const filtersOn = (r: AutonomousRunner) => (r as unknown as Internal).shouldFilterByEnabled();

  it('untouched + empty → filter OFF (legacy run-all fallback)', () => {
    const r = new AutonomousRunner(cfg());
    expect(r.getEnabledProjects()).toHaveLength(0);
    expect(filtersOn(r)).toBe(false); // no explicit selection yet → run all allowed
  });

  it('disabling every project → filter ON even though empty → nothing runs', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
    r.disableProject('/x/a');
    expect(r.getEnabledProjects()).toHaveLength(0);
    // The bug: empty used to mean "run all". Now touched → filter stays ON, so an
    // empty enabled-set means nothing runs.
    expect(filtersOn(r)).toBe(true);
  });

  it('disabling alone (no prior enable) still touches the selection', () => {
    const r = new AutonomousRunner(cfg());
    r.disableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
  });
});

describe('AutonomousRunner per-project candidate cap', () => {
  const makeTask = (id: string, projectPath: string): TaskItem => ({
    id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 3,
    projectPath,
    issueId: id,
    issueIdentifier: id.toUpperCase(),
    linearState: 'Todo',
    createdAt: Date.now(),
  });

  it('does not enqueue same-project heartbeat candidates past maxConcurrentPerProject', async () => {
    const repo = '/x/a';
    const other = '/x/b';
    const tasks = [
      makeTask('repo-1', repo),
      makeTask('repo-2', repo),
      makeTask('repo-3', repo),
      makeTask('other-1', other),
    ];
    const r = new AutonomousRunner(cfg({
      allowedProjects: [repo, other],
      autoExecute: true,
      maxConcurrentTasks: 3,
      allowSameProjectConcurrent: true,
      worktreeMode: true,
      maxConcurrentPerProject: 2,
    }));
    const internal = r as unknown as {
      engine: {
        heartbeatMultiple: ReturnType<typeof vi.fn>;
      };
      heartbeatParallel(tasks: TaskItem[]): Promise<void>;
      resolveProjectPath(task: TaskItem): Promise<string | null>;
      detectSafeCandidateIds(candidates: Array<{ task: TaskItem }>): Promise<Set<string>>;
      runAvailableTasks(): Promise<void>;
    };
    internal.engine.heartbeatMultiple = vi.fn(async () => ({
      action: 'execute',
      tasks: tasks.map(task => ({ task, workflow: {} })),
      reason: 'test',
      skippedCount: 0,
    }));
    internal.resolveProjectPath = vi.fn(async task => task.projectPath ?? null);
    internal.detectSafeCandidateIds = vi.fn(async candidates => new Set(candidates.map(c => c.task.id)));
    internal.runAvailableTasks = vi.fn(async () => {});

    await internal.heartbeatParallel(tasks);

    expect(r.getQueuedTasks().map(q => q.task.id)).toEqual(['repo-1', 'repo-2', 'other-1']);
    expect(r.getQueuedTasks().filter(q => q.projectPath === repo)).toHaveLength(2);
  });
});

describe('AutonomousRunner backlog grooming mapping (INT-1609)', () => {
  type Internal = { groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> };

  it('does not map an unmapped Linear project to the only allowed repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-groom-'));
    try {
      const r = new AutonomousRunner(cfg({ allowedProjects: [dir] }));
      const groups = await (r as unknown as Internal).groupTasksForGrooming([{
        id: 'task-1',
        source: 'linear',
        title: 'other project',
        priority: 1,
        createdAt: 1,
        issueId: 'issue-1',
        linearProject: { id: '11111111-1111-4111-8111-111111111111', name: 'Other' },
      }]);
      expect(groups.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('groups tasks only through explicit openswarm.json Linear project mapping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-groom-'));
    try {
      const projectId = '22222222-2222-4222-8222-222222222222';
      writeFileSync(join(dir, 'openswarm.json'), JSON.stringify({
        schemaVersion: 1,
        linear: { projectId },
      }));
      const r = new AutonomousRunner(cfg({ allowedProjects: [dir] }));
      const groups = await (r as unknown as Internal).groupTasksForGrooming([{
        id: 'task-1',
        source: 'linear',
        title: 'mapped project',
        priority: 1,
        createdAt: 1,
        issueId: 'issue-1',
        linearProject: { id: projectId, name: 'Mapped' },
      }]);
      expect(groups.get(dir)?.map(t => t.id)).toEqual(['task-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
