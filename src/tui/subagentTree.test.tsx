import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SubagentTree } from './components/SubagentTree.js';
import { buildSubagentTree } from './subagentTree.js';
import type { StageEntry } from './pipelineEvents.js';

describe('SubagentTree component (EPIC INT-1813 S7)', () => {
  it('renders an empty state', () => {
    expect(render(<SubagentTree repositories={[]} />).lastFrame()).toContain('no active agents');
  });

  it('renders repository, worktree and role nodes', () => {
    const stages: StageEntry[] = [
      {
        taskId: 'INT-2367-x',
        stage: 'worker',
        status: 'complete',
        model: 'gpt-5.2-codex',
        repository: 'OpenSwarm',
        worktree: 'INT-2367',
        branch: 'swarm/INT-2367-pipeline-tree',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      },
      { taskId: 'INT-2367-x', stage: 'reviewer', status: 'start', repository: 'OpenSwarm', worktree: 'INT-2367' },
    ];
    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('Agents by repository');
    expect(f).toContain('OpenSwarm');
    expect(f).toContain('INT-2367');
    expect(f).toContain('swarm/INT-2367-pipeline-tree');
    expect(f).toContain('Worker');
    expect(f).toContain('Reviewer');
  });

  it('renders compact running activity and real rate-limit reset data', () => {
    const stages: StageEntry[] = [
      {
        taskId: 'INT-2368-x',
        stage: 'worker',
        status: 'start',
        repository: 'OpenSwarm',
        issueIdentifier: 'INT-2368',
        activity: 'tool: apply_patch',
        model: 'codex',
      },
      {
        taskId: 'INT-2368-x',
        stage: 'reviewer',
        status: 'fail',
        repository: 'OpenSwarm',
        issueIdentifier: 'INT-2368',
        activity: 'rate-limited',
        rateLimitResetsAt: 1770000000000,
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('tool: apply_patch');
    expect(f).toContain('rate-limited');
    expect(f).toContain('reset 2026-');
  });

  it('honors zero display limits', () => {
    const stages: StageEntry[] = [
      { taskId: 'INT-1940-x', stage: 'worker', status: 'complete', model: 'gpt-5.2-codex' },
    ];

    expect(render(<SubagentTree repositories={buildSubagentTree(stages)} max={0} />).lastFrame()).toContain('no active agents');

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} maxRoles={0} />).lastFrame()!;
    expect(f).toContain('INT-1940');
    expect(f).not.toContain('(gpt-5.2-codex)');
  });

  it('strips terminal control sequences from labels before rendering', () => {
    const stages: StageEntry[] = [
      {
        taskId: '\x1b]52;c;AAAA\x07INT-1940-x',
        stage: 'worker\x1b[31m',
        status: 'complete',
        model: 'gpt\x1b]0;bad\x07',
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('INT-1940');
    expect(f).toContain('Worker');
    expect(f).toContain('gpt');
    expect(f).not.toContain('\x1b');
    expect(f).not.toContain('AAAA');
    expect(f).not.toContain('bad');
  });
});
