// Purpose: same-repo concurrency flag + worktree-isolation guard (INT-1975).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskScheduler } from './taskScheduler.js';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const task = (id: string): TaskItem => ({ id, title: id, priority: 3 } as TaskItem);

// Executor that never resolves — keeps the task "running" so isProjectBusy is testable.
function pendingExecutor() {
  return () => new Promise<PipelineResult>(() => {});
}

describe('TaskScheduler same-project concurrency (INT-1975)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('serializes same-repo tasks by default (no flag)', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(true);
  });

  it('allows same-repo parallelism when flag + worktreeMode are both on', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(false);
    expect(s.getBusyProjects()).toEqual([]);
  });

  it('force-disables the flag when worktreeMode is off, and warns', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: false, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    // Guard ignored the flag → project is still busy (serialized, safe).
    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires worktreeMode'));
  });

  it('getNextExecutable hands out two same-repo tasks when concurrency is allowed', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.enqueue(task('a'), '/repo');
    s.enqueue(task('b'), '/repo');
    const first = s.getNextExecutable();
    s.startTask(first!.task, first!.projectPath, pendingExecutor());
    // Without the flag this would return null (project busy); with it, 'b' is dispatchable.
    expect(s.getNextExecutable()?.task.id).toBe('b');
  });

  it('caps same-repo parallelism when maxConcurrentPerProject is set', () => {
    const s = new TaskScheduler({
      maxConcurrent: 4,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
      maxConcurrentPerProject: 2,
    });
    s.enqueue(task('a'), '/repo');
    s.enqueue(task('b'), '/repo');
    s.enqueue(task('c'), '/repo');
    s.enqueue(task('d'), '/other');

    const first = s.getNextExecutable();
    s.startTask(first!.task, first!.projectPath, pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(false);

    const second = s.getNextExecutable();
    s.startTask(second!.task, second!.projectPath, pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(s.getBusyProjects()).toEqual(['/repo']);

    // Third same-repo task is held back, but another project can still use slots.
    expect(s.getNextExecutable()?.task.id).toBe('d');
  });

  it('reapplies the same-project worktree guard when config is updated', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.updateConfig({ worktreeMode: false, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());

    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires worktreeMode'));
  });
});
