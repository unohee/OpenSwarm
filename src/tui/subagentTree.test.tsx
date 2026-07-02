import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SubagentTree } from './components/SubagentTree.js';
import { buildSubagentTree } from './subagentTree.js';
import type { StageEntry } from './pipelineEvents.js';

describe('SubagentTree component (EPIC INT-1813 S7)', () => {
  it('renders an empty state', () => {
    expect(render(<SubagentTree tasks={[]} />).lastFrame()).toContain('no active agents');
  });

  it('renders a task node with its stage children', () => {
    const stages: StageEntry[] = [
      { taskId: 'INT-1940-x', stage: 'worker', status: 'complete', model: 'gpt-5.2-codex' },
      { taskId: 'INT-1940-x', stage: 'reviewer', status: 'start' },
    ];
    const f = render(<SubagentTree tasks={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('Agents (by task)');
    expect(f).toContain('INT-1940-x');
    expect(f).toContain('worker');
    expect(f).toContain('reviewer');
  });

  it('honors zero display limits', () => {
    const stages: StageEntry[] = [
      { taskId: 'INT-1940-x', stage: 'worker', status: 'complete', model: 'gpt-5.2-codex' },
    ];

    expect(render(<SubagentTree tasks={buildSubagentTree(stages)} max={0} />).lastFrame()).toContain('no active agents');

    const f = render(<SubagentTree tasks={buildSubagentTree(stages)} maxStages={0} />).lastFrame()!;
    expect(f).toContain('INT-1940-x');
    expect(f).not.toContain('worker');
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

    const f = render(<SubagentTree tasks={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('INT-1940-x');
    expect(f).toContain('worker');
    expect(f).toContain('gpt');
    expect(f).not.toContain('\x1b');
    expect(f).not.toContain('AAAA');
    expect(f).not.toContain('bad');
  });
});
