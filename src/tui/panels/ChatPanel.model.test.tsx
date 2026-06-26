// Purpose: /model direct switch (INT-1961). The bare-/model async selector reuses
// the selector path covered by ChatPanel.provider.test.tsx.
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ChatPanel } from './ChatPanel.js';

const tick = () => new Promise((r) => setTimeout(r, 60));

describe('ChatPanel /model (INT-1961)', () => {
  it('switches model directly with /model <name>', async () => {
    const { stdin, lastFrame } = render(<ChatPanel active />);
    stdin.write('/model my-cool-model');
    await tick();
    stdin.write('\r'); // has a space → submit (no palette)
    await tick();
    expect(lastFrame()).toContain('Model → my-cool-model');
  });
});
