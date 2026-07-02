import { describe, it, expect, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { TaskScheduler } from './taskScheduler.js';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const task = (id: string): TaskItem => ({ id, title: id, priority: 3 } as TaskItem);
const cancelledResult = () => ({ success: false, finalStatus: 'cancelled' } as PipelineResult);
const okResult = () => ({ success: true, finalStatus: 'approved' } as PipelineResult);

// A controllable executor: resolves only when we tell it to, and records whether
// its abort signal fired — that's how we assert cancellation actually propagates.
function deferredExecutor() {
  let resolve!: (r: PipelineResult) => void;
  const done = new Promise<PipelineResult>((r) => { resolve = r; });
  let abortedSignal: AbortSignal | undefined;
  const exec = (signal: AbortSignal) => { abortedSignal = signal; return done; };
  return { exec, resolve, wasAborted: () => !!abortedSignal?.aborted };
}

describe('TaskScheduler cancellation', () => {
  let sched: TaskScheduler;
  beforeEach(() => { sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true }); });

  it('cancelTask aborts the signal handed to the executor', () => {
    const d = deferredExecutor();
    sched.startTask(task('t1'), '/repo', d.exec);
    expect(d.wasAborted()).toBe(false);
    expect(sched.cancelTask('t1')).toBe(true);
    expect(d.wasAborted()).toBe(true);
  });

  it('cancelTask returns false for an unknown task', () => {
    expect(sched.cancelTask('nope')).toBe(false);
  });

  it('cancelProjectTasks aborts every task on the project (repo + worktree paths)', () => {
    const a = deferredExecutor();
    const b = deferredExecutor();
    const c = deferredExecutor();
    sched.startTask(task('a'), '/dev/WAVE', a.exec);
    sched.startTask(task('b'), '/dev/WAVE/worktree/abc', b.exec); // worktree under repo
    sched.startTask(task('c'), '/dev/other', c.exec);
    const n = sched.cancelProjectTasks('/dev/WAVE');
    expect(n).toBe(2);
    expect(a.wasAborted()).toBe(true);
    expect(b.wasAborted()).toBe(true);
    expect(c.wasAborted()).toBe(false);
  });

  it('cancelProjectTasks does not abort sibling paths with the same prefix', () => {
    const a = deferredExecutor();
    const b = deferredExecutor();
    sched.startTask(task('a'), '/dev/WAVE', a.exec);
    sched.startTask(task('b'), '/dev/WAVE-next', b.exec);
    const n = sched.cancelProjectTasks('/dev/WAVE');
    expect(n).toBe(1);
    expect(a.wasAborted()).toBe(true);
    expect(b.wasAborted()).toBe(false);
  });

  it('cancelProjectTasks matches home-expanded project paths', () => {
    const d = deferredExecutor();
    sched.startTask(task('home'), resolve(homedir(), 'dev/WAVE'), d.exec);
    const n = sched.cancelProjectTasks('~/dev/WAVE');
    expect(n).toBe(1);
    expect(d.wasAborted()).toBe(true);
  });

  it('cancelProjectTasks matches relative project paths', () => {
    const d = deferredExecutor();
    sched.startTask(task('relative'), resolve(process.cwd(), 'relative-WAVE'), d.exec);
    const n = sched.cancelProjectTasks('./relative-WAVE');
    expect(n).toBe(1);
    expect(d.wasAborted()).toBe(true);
  });

  it('cancelProjectTasks with an empty/blank path cancels nothing (not cwd)', () => {
    const d = deferredExecutor();
    sched.startTask(task('cwd-task'), resolve(process.cwd(), 'some-repo'), d.exec);
    expect(sched.cancelProjectTasks('')).toBe(0);
    expect(sched.cancelProjectTasks('   ')).toBe(0);
    expect(d.wasAborted()).toBe(false);
  });

  it("a cancelled result is not counted as failed", async () => {
    const d = deferredExecutor();
    const events: string[] = [];
    sched.on('cancelled', () => events.push('cancelled'));
    sched.on('failed', () => events.push('failed'));
    sched.startTask(task('t'), '/repo', d.exec);
    d.resolve(cancelledResult());
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['cancelled']);
    expect(sched.getStats().failed).toBe(0);
    expect(sched.getStats().completed).toBe(0);
    expect(sched.isTaskRunning('t')).toBe(false);
  });

  it('a normal success still completes (cancellation path is additive)', async () => {
    const d = deferredExecutor();
    sched.startTask(task('t'), '/repo', d.exec);
    d.resolve(okResult());
    await new Promise((r) => setTimeout(r, 0));
    expect(sched.getStats().completed).toBe(1);
  });

  it('setTaskStage updates the running task for the dashboard view', () => {
    sched.startTask(task('t'), '/repo', deferredExecutor().exec);
    sched.setTaskStage('t', 'reviewer');
    expect(sched.getRunningTasks().find((r) => r.task.id === 't')?.stage).toBe('reviewer');
  });
});
