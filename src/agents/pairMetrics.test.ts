import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => ({
  path: `/tmp/openswarm-pair-metrics-${process.pid}`,
}));

vi.mock('node:os', () => ({ homedir: () => testHome.path }));

import {
  getRecentSessions,
  getSummary,
  recordSession,
  resetPairMetricsForTests,
  type PairSessionRecord,
} from './pairMetrics.js';

const metricsDir = `${testHome.path}/.openswarm/metrics`;
const recordsFile = `${metricsDir}/pair-records.json`;

function record(sessionId: string): PairSessionRecord {
  return {
    sessionId,
    taskId: `task-${sessionId}`,
    taskTitle: sessionId,
    result: 'approved',
    attempts: 1,
    maxAttempts: 3,
    durationMs: 100,
    filesChanged: 1,
    startedAt: 1,
    finishedAt: 2,
  };
}

describe('pair metrics persistence', () => {
  beforeEach(async () => {
    await rm(testHome.path, { recursive: true, force: true });
    resetPairMetricsForTests();
  });

  afterEach(async () => {
    resetPairMetricsForTests();
    await rm(testHome.path, { recursive: true, force: true });
  });

  it('serializes concurrent records without losing either session', async () => {
    await Promise.all([recordSession(record('one')), recordSession(record('two'))]);

    expect((await getRecentSessions(10)).map((item) => item.sessionId).sort()).toEqual(['one', 'two']);
    expect(JSON.parse(await readFile(recordsFile, 'utf8'))).toHaveLength(2);
    expect((await stat(recordsFile)).mode & 0o777).toBe(0o600);
  });

  it('fails safe when persisted records are malformed', async () => {
    await mkdir(metricsDir, { recursive: true });
    await writeFile(recordsFile, JSON.stringify([{ sessionId: 'partial' }]));

    expect(await getSummary()).toMatchObject({ totalSessions: 0, approved: 0 });
    expect(await getRecentSessions()).toEqual([]);
  });

  it('rejects invalid incoming records before touching storage', async () => {
    await expect(recordSession({ ...record('bad'), attempts: -1 })).rejects.toThrow('Invalid pair session record');
  });
});
