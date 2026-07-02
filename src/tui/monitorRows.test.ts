import { describe, it, expect } from 'vitest';
import {
  projectsToTable,
  pipelineToTable,
  stuckToTable,
  issuesToTable,
} from './monitorRows.js';

describe('monitorRows (EPIC INT-1813 S6)', () => {
  it('projectsToTable maps enabled flag and run/queue counts', () => {
    const t = projectsToTable([
      { name: 'A', path: '/a', enabled: true, running: ['x'], queued: [] },
      { name: 'B', path: '/b', enabled: false },
    ]);
    expect(t.columns).toEqual(['', 'PROJECT', 'RUN', 'QUEUE']);
    expect(t.rows[0]).toEqual(['●', 'A', '1', '0']);
    expect(t.rows[1]).toEqual(['○', 'B', '0', '0']);
  });

  it('pipelineToTable joins task:started titles to stage rows, newest first', () => {
    const t = pipelineToTable([
      { type: 'task:started', data: { taskId: 't1', issueIdentifier: 'INT-9' } },
      { type: 'pipeline:stage', data: { taskId: 't1', stage: 'worker', status: 'start', model: 'gpt-5.2-codex' } },
      { type: 'pipeline:stage', data: { taskId: 't1', stage: 'reviewer', status: 'complete' } },
    ]);
    expect(t.rows[0][0]).toBe('INT-9');
    expect(t.rows[0][1]).toBe('reviewer'); // newest first
    expect(t.rows[1][1]).toBe('worker');
    expect(t.rows[1][2]).toBe('5.2-codex'); // model shortened
  });

  it('stuckToTable tags stuck vs failed and truncates long text', () => {
    const t = stuckToTable(
      [{ identifier: 'INT-1', title: 'short', reason: 'no retry', priority: 1 }],
      [{ identifier: 'INT-2', title: 'x'.repeat(60), reason: 'boom', priority: 3 }],
    );
    expect(t.rows[0]).toEqual(['stuck', 'INT-1', 'short', 'urgent', 'no retry']);
    expect(t.rows[1][0]).toBe('failed');
    expect(t.rows[1][2].endsWith('…')).toBe(true);
  });

  it('issuesToTable maps title/status/priority', () => {
    const t = issuesToTable([{ id: '1', title: 'fix it', status: 'open', priority: 2 }]);
    expect(t.rows[0]).toEqual(['fix it', 'open', 'high']);
  });

  it('issuesToTable maps GraphQL enum priorities', () => {
    const t = issuesToTable([
      { id: '1', title: 'urgent issue', status: 'open', priority: 'urgent' },
      { id: '2', title: 'medium issue', status: 'open', priority: 'medium' },
      { id: '3', title: 'none issue', status: 'open', priority: 'none' },
    ]);
    expect(t.rows.map((r) => r[2])).toEqual(['urgent', 'med', 'none']);
  });
});
