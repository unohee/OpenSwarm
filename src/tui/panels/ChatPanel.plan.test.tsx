import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

let confirmSettled: Promise<'yes' | 'no' | 'edit'> | undefined;
vi.mock('../../support/planCommand.js', () => ({
  runPlanCommand: vi.fn(async (_goal: string, io: { confirm(prompt: string): Promise<'yes' | 'no' | 'edit'> }) => {
    confirmSettled = io.confirm('Proceed?');
    return confirmSettled;
  }),
}));

import { ChatPanel } from './ChatPanel.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('ChatPanel PlanIO lifecycle', () => {
  it('settles a pending confirmation when the panel unmounts', async () => {
    const view = render(<ChatPanel active />);
    view.stdin.write('/plan test');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(confirmSettled).toBeDefined();
    view.unmount();
    await expect(confirmSettled).resolves.toBe('no');
  });
});
