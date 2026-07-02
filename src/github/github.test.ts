import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => {
  const fn = vi.fn();
  (fn as any)[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      (fn as any)(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return fn;
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

import { checkPRCIStatus, getActiveFailures, getPRChecks } from './github.js';

function mockGhJson(value: unknown): void {
  execFileMock.mockImplementationOnce((
    _cmd: string,
    _args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, JSON.stringify(value), '');
  });
}

describe('getPRChecks', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('normalizes gh pr checks buckets into CI status and conclusion values', async () => {
    mockGhJson([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail' },
      { name: 'build', state: 'QUEUED', bucket: 'pending' },
      { name: 'docs', state: 'SKIPPED', bucket: 'skipping' },
      { name: 'deploy', state: 'CANCELLED', bucket: 'cancel' },
    ]);

    await expect(getPRChecks('owner/repo', 42)).resolves.toEqual([
      { name: 'unit', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'pending', conclusion: 'pending' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
      { name: 'deploy', status: 'completed', conclusion: 'cancelled' },
    ]);

    expect(execFileMock.mock.calls[0][1]).toContain('name,state,bucket');
  });

  it('reports failed PR CI when gh classifies a check in the fail bucket', async () => {
    mockGhJson([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass' },
      { name: 'lint', state: 'FAILURE', bucket: 'fail' },
    ]);

    await expect(checkPRCIStatus('owner/repo', 42)).resolves.toEqual({
      status: 'failure',
      failedChecks: [{ name: 'lint', conclusion: 'failure' }],
    });
  });
});

describe('getActiveFailures', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects failures that would have been beyond the old latest-20 run window', async () => {
    const runs = Array.from({ length: 24 }, (_, i) => ({
      databaseId: i + 1,
      name: 'ci',
      headBranch: `feature-${i}`,
      createdAt: '2026-06-30T00:00:00.000Z',
      conclusion: 'success',
      url: `https://example.test/runs/${i + 1}`,
    }));
    runs.push({
      databaseId: 25,
      name: 'ci',
      headBranch: 'still-failing',
      createdAt: '2026-06-20T00:00:00.000Z',
      conclusion: 'failure',
      url: 'https://example.test/runs/25',
    });
    mockGhJson(runs);

    await expect(getActiveFailures('owner/repo', 30)).resolves.toEqual([
      {
        workflow: 'ci',
        branch: 'still-failing',
        runId: 25,
        url: 'https://example.test/runs/25',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ]);

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('--created');
    expect(args).toContain('>=2026-06-01');
    expect(args).toContain('-L');
    expect(args).toContain('1000');
    expect(args).not.toContain('20');
  });
});
