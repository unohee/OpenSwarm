// Purpose: LiveLog renders highlighted log lines (INT-1974).
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { LiveLog } from './LiveLog.js';

describe('LiveLog (INT-1974)', () => {
  it('renders each line with its content (highlighted via LogLine)', () => {
    const f = render(
      <LiveLog logs={['[worker] [de-artifact | INT-1918 | worktree/0cc4e232] Codex turn completed']} />,
    ).lastFrame()!;
    expect(f).toContain('[worker]');
    expect(f).toContain('INT-1918');
    expect(f).toContain('Codex turn completed');
  });

  it('shows the empty placeholder when there are no logs', () => {
    expect(render(<LiveLog logs={[]} />).lastFrame()).toContain('no log output yet');
  });

  it('caps to the most recent `max` lines', () => {
    const logs = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const f = render(<LiveLog logs={logs} max={3} />).lastFrame()!;
    expect(f).toContain('line 19');
    expect(f).not.toContain('line 16');
  });
});
