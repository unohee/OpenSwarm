// Purpose: Logs tab renders the live-log view with connection status (INT-1962).
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { LogsPanel } from './LogsPanel.js';

describe('LogsPanel (INT-1962)', () => {
  it('shows an idle status and the live-log frame when no daemon port', () => {
    const f = render(<LogsPanel />).lastFrame()!;
    expect(f).toContain('daemon port unknown');
    expect(f).toContain('Live log');
  });

  it('shows a connecting status when a port is set', () => {
    const f = render(<LogsPanel port={3847} />).lastFrame()!;
    expect(f).toMatch(/:3847/);
  });
});
