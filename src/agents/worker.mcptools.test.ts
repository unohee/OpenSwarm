// Purpose: WorkerOptions.mcpTools is forwarded to the adapter spawnCli call (INT-1950)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from '../adapters/tools.js';

const spawnCli = vi.fn(async () => 'raw');
const parseWorkerOutput = vi.fn(() => ({
  success: true,
  summary: 's',
  filesChanged: [],
  commands: [],
  output: 'o',
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ parseWorkerOutput }),
  getDefaultAdapterName: () => 'gpt',
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runWorker } = await import('./worker.js');

describe('runWorker mcpTools pass-through (INT-1950)', () => {
  beforeEach(() => spawnCli.mockClear());

  it('forwards mcpTools to the adapter spawnCli options', async () => {
    const mcpTools: ToolDefinition[] = [
      { type: 'function', function: { name: 'linear__list_issues', description: '', parameters: { type: 'object', properties: {} } } },
    ];
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt', mcpTools });
    expect(spawnCli).toHaveBeenCalled();
    const opts = spawnCli.mock.calls[0][1] as { mcpTools?: ToolDefinition[] };
    expect(opts.mcpTools).toBe(mcpTools);
  });

  it('leaves mcpTools undefined when not provided', async () => {
    await runWorker({ taskTitle: 't', taskDescription: 'd', projectPath: '/p', adapterName: 'gpt' });
    const opts = spawnCli.mock.calls[0][1] as { mcpTools?: ToolDefinition[] };
    expect(opts.mcpTools).toBeUndefined();
  });
});
