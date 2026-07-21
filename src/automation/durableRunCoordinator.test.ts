import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';

const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string, state = 'Todo'): TaskItem {
  return {
    id,
    issueId: id,
    issueIdentifier: id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 2,
    createdAt: Date.now(),
    linearState: state,
    linearProject: { id: 'project', name: 'Repo' },
  };
}

function result(success = true): PipelineResult {
  return {
    success,
    sessionId: 'session-1',
    stages: [],
    finalStatus: success ? 'approved' : 'infra_error',
    totalDuration: 100,
    iterations: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DurableRunCoordinator', () => {
  it('admits only one concurrent run per repository across coordinator instances', async () => {
    const path = dbPath();
    const first = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'a' });
    const second = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'b' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const firstRun = first.execute(task('A'), '/repo', async () => {
      await held;
      return result();
    }, {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `A:${claim.attemptNo}`, payload: {},
      }),
    });
    const secondResult = await second.execute(task('B'), '/repo', async () => result());

    expect(secondResult.finalStatus).toBe('superseded');
    expect(second.getRun('B')).toMatchObject({ state: 'RETRY_AT' });
    expect(second.getRun('B')?.retryAt).toBeGreaterThan(Date.now());
    release();
    expect((await firstRun).success).toBe(true);
    first.close();
    second.close();
  });

  it('records worktree, verification, publication, and durable sync state', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const pipeline = await coordinator.execute(task('FLOW'), '/repo', async (hooks) => {
      expect(await hooks.onWorktree({
        issueId: 'FLOW', branchName: 'swarm/FLOW',
        worktreePath: '/repo/worktree/FLOW', originalPath: '/repo',
      })).toBe(true);
      expect(await hooks.onStage('reviewer')).toBe(true);
      expect(await hooks.beforePublish()).toBe(true);
      expect(await hooks.onPublication('https://github.test/pr/1', 'abc123')).toBe(true);
      return { ...result(), prUrl: 'https://github.test/pr/1' };
    }, {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete',
        dedupeKey: `FLOW:${claim.attemptNo}`,
        payload: { marker: 'FLOW:1' },
      }),
    });

    expect(pipeline.success).toBe(true);
    expect(coordinator.getRun('FLOW')).toMatchObject({
      state: 'SYNC_PENDING',
      worktreePath: '/repo/worktree/FLOW',
      branchName: 'swarm/FLOW',
      prUrl: 'https://github.test/pr/1',
      headSha: 'abc123',
    });
    expect(coordinator.getProtectedWorktreePaths('/repo')).toEqual(new Set(['/repo/worktree/FLOW']));
    coordinator.close();
  });

  it('reconciles a published PR before any retry when publication attachment throws', async () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'daemon',
    });
    vi.spyOn(ledger, 'attachPublication').mockImplementation(() => {
      throw new Error('database unavailable after GitHub accepted the PR');
    });

    const published = await coordinator.execute(task('PUBLISH-RACE'), '/repo', async (hooks) => {
      expect(await hooks.beforePublish()).toBe(true);
      const prUrl = 'https://github.test/pr/42';
      try {
        await hooks.onPublication(prUrl, 'deadbeef');
      } catch {
        // executePipeline preserves the URL and converts this exact boundary
        // failure into an infra_error result.
      }
      return { ...result(false), prUrl };
    }, {
      admission: { maxFailuresPerHour: 1 },
    });

    expect(published).toMatchObject({
      success: false,
      finalStatus: 'infra_error',
      prUrl: 'https://github.test/pr/42',
    });
    expect(coordinator.getRun('PUBLISH-RACE')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      prUrl: 'https://github.test/pr/42',
      lastErrorCode: 'publication_reconcile',
    });

    const duplicateExecutor = vi.fn(async () => result());
    expect((await coordinator.execute(task('PUBLISH-RACE'), '/repo', duplicateExecutor)).finalStatus)
      .toBe('superseded');
    expect(duplicateExecutor).not.toHaveBeenCalled();

    // A publication reconciliation is coordination debt, not evidence that the
    // repository itself is failing. It must not open the failure circuit.
    expect((await coordinator.execute(task('AFTER-PUBLISH-RACE'), '/repo', async () => result(), {
      admission: { maxConcurrent: 2, maxFailuresPerHour: 1 },
    })).success).toBe(true);
    expect(ledger.getMetrics().openCircuits).toBe(0);

    coordinator.close();
    ledger.close();
  });

  it('finalizes only after its durable outbox effect is acknowledged', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('SYNC'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `SYNC:${claim.attemptNo}`, payload: { marker: 'SYNC:1' },
      }),
    });
    expect(coordinator.getRun('SYNC')?.state).toBe('SYNC_PENDING');

    const delivered: string[] = [];
    await expect(coordinator.drainOutbox(async (effect) => {
      delivered.push(effect.dedupeKey);
    })).resolves.toMatchObject({ applied: 1, retried: 0, dead: 0 });

    expect(delivered).toEqual(['SYNC:1']);
    expect(coordinator.getRun('SYNC')?.state).toBe('DONE');
    coordinator.close();
  });

  it('keeps cancellation fenced until tracker synchronization is acknowledged', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const cancelled = await coordinator.execute(task('CANCEL-SYNC'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'cancelled',
    }), {
      cancelEffect: (_pipeline, claim) => ({
        kind: 'tracker.cancel',
        dedupeKey: `CANCEL-SYNC:${claim.attemptNo}`,
        payload: { marker: 'CANCEL-SYNC:1' },
      }),
    });

    expect(cancelled.finalStatus).toBe('cancelled');
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('SYNC_PENDING');
    // A stale Todo observation cannot reopen a cancellation whose remote state
    // has not converged yet.
    expect(coordinator.observeTask(task('CANCEL-SYNC', 'Todo'), '/repo')?.state).toBe('SYNC_PENDING');

    await expect(coordinator.drainOutbox(async () => {
      throw new Error('tracker unavailable');
    }, { maxEffects: 1 })).resolves.toEqual({ applied: 0, retried: 1, dead: 0 });
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('SYNC_PENDING');

    await expect(coordinator.drainOutbox(async () => {}, {
      maxEffects: 1,
      now: () => Date.now() + 60_000,
    })).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('CANCELLED');
    coordinator.close();
  });

  it('keeps a failed delivery pending and never reports the run done', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('RETRY'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `RETRY:${claim.attemptNo}`, payload: {},
      }),
    });

    const drained = await coordinator.drainOutbox(async () => {
      throw new Error('tracker unavailable');
    }, { maxEffects: 1 });
    expect(drained).toEqual({ applied: 0, retried: 1, dead: 0 });
    expect(coordinator.getRun('RETRY')?.state).toBe('SYNC_PENDING');
    coordinator.close();
  });

  it('parks a run for human intervention when an outbox effect exhausts delivery', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('DEAD'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `DEAD:${claim.attemptNo}`, payload: {},
      }),
    });

    await expect(coordinator.drainOutbox(async () => {
      throw new Error('permanent permission failure');
    }, { maxEffects: 1, maxAttempts: 1 })).resolves.toEqual({ applied: 0, retried: 0, dead: 1 });
    expect(coordinator.getRun('DEAD')).toMatchObject({ state: 'NEEDS_HUMAN', lastErrorCode: 'needs_human' });

    expect(coordinator.resumeNeedsHuman('DEAD')).toBe('SYNC_PENDING');
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(coordinator.getRun('DEAD')?.state).toBe('DONE');
    coordinator.close();
  });

  it('backs a superseded preflight off instead of spinning in WAITING_EXTERNAL', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const effectFactory = vi.fn();
    const deferred = await coordinator.execute(task('SUPERSEDED'), '/repo', async () => ({
      ...result(true), finalStatus: 'superseded',
    }), { successEffect: effectFactory });
    expect(deferred.finalStatus).toBe('superseded');
    expect(coordinator.getRun('SUPERSEDED')).toMatchObject({ state: 'RETRY_AT' });
    expect(coordinator.getRun('SUPERSEDED')?.retryAt).toBeGreaterThan(Date.now());
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    coordinator.close();
  });

  it('treats successful decomposition as DECOMPOSED without tracker completion effects', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const effectFactory = vi.fn();
    const decomposed = await coordinator.execute(task('PARENT'), '/repo', async () => ({
      ...result(), finalStatus: 'decomposed', success: true,
    }), { successEffect: effectFactory });

    expect(decomposed.finalStatus).toBe('decomposed');
    expect(coordinator.getRun('PARENT')?.state).toBe('DECOMPOSED');
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    coordinator.close();
  });

  it('reopens every terminal state only from an explicit Todo observation', async () => {
    for (const terminal of ['DONE', 'DECOMPOSED', 'CANCELLED'] as const) {
      const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: `daemon-${terminal}` });
      const issue = `REOPEN-${terminal}`;
      const completed = await coordinator.execute(task(issue), '/repo', async () => ({
        ...result(terminal === 'DONE'),
        success: terminal !== 'CANCELLED',
        finalStatus: terminal === 'DECOMPOSED' ? 'decomposed' : terminal === 'CANCELLED' ? 'cancelled' : 'approved',
      }));
      expect(completed.finalStatus).toBe(terminal === 'DONE' ? 'approved' : terminal === 'DECOMPOSED' ? 'decomposed' : 'cancelled');
      expect(coordinator.getRun(issue)?.state).toBe(terminal);

      expect(coordinator.observeTask(task(issue, 'In Progress'), '/repo')?.state).toBe(terminal);
      expect(coordinator.observeTask(task(issue, 'Todo'), '/repo')?.state).toBe('READY');
      coordinator.close();
    }
  });

  it('shadow mode observes but does not block execution when another owner holds the claim', async () => {
    const path = dbPath();
    const primary = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'primary' });
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: path, instanceId: 'shadow' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const primaryRun = primary.execute(task('SHADOW'), '/repo', async () => {
      await held;
      return result(false);
    });
    const shadowExecutor = vi.fn(async () => result(false));

    expect((await shadow.execute(task('SHADOW'), '/repo', shadowExecutor)).finalStatus).toBe('infra_error');
    expect(shadowExecutor).toHaveBeenCalledOnce();
    release();
    await primaryRun;
    primary.close();
    shadow.close();
  });

  it('shadow mode never creates a claim or outbox effect when it is the only observer', async () => {
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: dbPath(), instanceId: 'shadow' });
    const effectFactory = vi.fn(() => ({
      kind: 'tracker.complete', dedupeKey: 'SHADOW-ONLY:1', payload: {},
    }));

    expect((await shadow.execute(task('SHADOW-ONLY'), '/repo', async () => result(), {
      successEffect: effectFactory,
    })).success).toBe(true);
    expect(shadow.getRun('SHADOW-ONLY')).toMatchObject({ state: 'READY', attemptNo: 0 });
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(shadow.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    shadow.close();
  });

  it('shadow mode cannot deliver another coordinator\'s shared outbox effect', async () => {
    const path = dbPath();
    const primary = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'primary' });
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: path, instanceId: 'shadow' });
    await primary.execute(task('SHADOW-OUTBOX'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `SHADOW-OUTBOX:${claim.attemptNo}`, payload: {},
      }),
    });
    const deliver = vi.fn(async () => {});

    await expect(shadow.drainOutbox(deliver)).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    expect(deliver).not.toHaveBeenCalled();
    await expect(primary.drainOutbox(deliver)).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    primary.close();
    shadow.close();
  });

  it('keeps the repository fenced until a lease-lost executor actually exits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const old = new DurableRunCoordinator({
      mode: 'primary', dbPath: path, instanceId: 'old', leaseMs: 3_000,
    });
    let oldHooks!: Parameters<Parameters<DurableRunCoordinator['execute']>[2]>[0];
    let oldLeaseSignal!: AbortSignal;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const oldRun = old.execute(task('FENCE-STAGE'), '/repo', async (hooks, leaseSignal) => {
      oldHooks = hooks;
      oldLeaseSignal = leaseSignal;
      expect(await hooks.onStage('reviewer')).toBe(true);
      await held;
      return result();
    });
    await Promise.resolve();

    vi.setSystemTime(5_000); // do not run the old renewal interval
    const replacementLedger = new RunLedger(path);
    replacementLedger.registerRun({
      issueId: 'FENCE-OTHER', source: 'linear', projectPath: '/repo',
    }, 5_000);
    expect(replacementLedger.reconcileExpiredLeases(5_000)).toHaveLength(1);
    expect(replacementLedger.markReady('FENCE-STAGE', 5_001)).toBe(false);
    expect(replacementLedger.claimRun('FENCE-OTHER', {
      ownerInstanceId: 'new', leaseMs: 3_000, now: 5_001,
    })).toBeNull();

    expect(await oldHooks.onStage('reviewer')).toBe(false);
    expect(oldLeaseSignal.aborted).toBe(true);
    release();
    expect((await oldRun).finalStatus).toBe('infra_error');
    expect(replacementLedger.getRun('FENCE-STAGE')?.ownerInstanceId).toBeUndefined();
    expect(replacementLedger.markReady('FENCE-STAGE', 5_002)).toBe(true);
    expect(replacementLedger.claimRun('FENCE-OTHER', {
      ownerInstanceId: 'new', leaseMs: 3_000, now: 5_003,
    })).not.toBeNull();
    replacementLedger.close();
    old.close();
  });

  it('releases an expired owner only after proving its process is dead', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'DEAD-OWNER', source: 'linear', projectPath: '/repo' }, 1_000);
    const stale = ledger.claimRun('DEAD-OWNER', {
      ownerInstanceId: '424242-dead-owner', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(stale, 'EXECUTING', {}, 1_100)).toBe(true);
    const replacement = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'replacement', processIsAlive: () => false,
    });

    expect(replacement.reconcile(4_001)).toHaveLength(1);
    expect(ledger.getRun('DEAD-OWNER')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    expect(ledger.markReady('DEAD-OWNER', 4_002)).toBe(true);
    replacement.close();
    ledger.close();
  });
});
