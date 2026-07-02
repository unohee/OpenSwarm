import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initLocale } from '../locale/index.js';

// Mock the adapter layer so runPlanner exercises the agentic-loop path without a real model.
vi.mock('../adapters/index.js', () => ({
  getAdapter: vi.fn(() => ({ name: 'mock' })),
  spawnCli: vi.fn(),
}));

import { runPlanner } from './planner.js';
import * as adapters from '../adapters/index.js';

const mockedSpawnCli = vi.mocked(adapters.spawnCli);

function cliResult(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'boom', durationMs: 1 };
}

const PLAN_JSON =
  '```json\n{"needsDecomposition":true,"subTasks":[{"title":"A","description":"d","estimatedMinutes":20,"priority":2}],"totalEstimatedMinutes":20}\n```';

beforeAll(() => { initLocale('en'); });
afterEach(() => { vi.clearAllMocks(); });

describe('runPlanner — agentic loop migration', () => {
  it('parses a decomposition from the loop plain-text JSON output', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(`Here is the plan:\n${PLAN_JSON}`) as never);
    const res = await runPlanner({ taskTitle: 'big task', taskDescription: 'do it', projectPath: '/tmp/x' });
    expect(res.success).toBe(true);
    expect(res.needsDecomposition).toBe(true);
    expect(res.subTasks).toHaveLength(1);
    expect(res.subTasks[0].title).toBe('A');
  });

  it('runs read-only and multi-turn (guard appended, maxTurns > 1)', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x' });
    const opts = mockedSpawnCli.mock.calls[0][1];
    expect(opts.prompt).toContain('PLANNING ONLY');
    expect(opts.readOnly).toBe(true);
    expect(opts.maxTurns).toBeGreaterThan(1);
  });

  it('drops a Claude-CLI model id (claude-*) → adapter default', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'claude-opus-4-7' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBeUndefined();
  });

  it('keeps an OpenRouter-style Claude model id (org-prefixed)', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'anthropic/claude-opus-4' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBe('anthropic/claude-opus-4');
  });

  it('returns failure when the adapter errors with no output', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult('', 1) as never);
    const res = await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x' });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
