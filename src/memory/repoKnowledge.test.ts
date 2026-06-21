import { afterEach, describe, expect, it, vi } from 'vitest';

// Isolate from the real memory store — assert what recordTaskOutcome persists, not where.
const saveMemory = vi.fn(async () => undefined);
vi.mock('./memoryCore.js', () => ({
  saveMemory: (...args: unknown[]) => saveMemory(...args),
  searchMemorySafe: vi.fn(async () => []),
}));

const { recordTaskOutcome } = await import('./repoKnowledge.js');

describe('recordTaskOutcome', () => {
  afterEach(() => saveMemory.mockClear());

  it('stores a rejection as a constraint (pitfall)', async () => {
    await recordTaskOutcome('/tmp/repo', {
      taskTitle: 'Add login',
      rejectionFeedback: 'Missing input validation',
    });
    expect(saveMemory).toHaveBeenCalledTimes(1);
    const [type, , , content] = saveMemory.mock.calls[0];
    expect(type).toBe('constraint');
    expect(content).toContain('Missing input validation');
  });

  it('stores a success as a system_pattern', async () => {
    await recordTaskOutcome('/tmp/repo', {
      taskTitle: 'Add login',
      workerResult: { filesChanged: ['auth.ts'], commands: [], summary: 'wired OAuth' },
    });
    const types = saveMemory.mock.calls.map((c) => c[0]);
    expect(types).toContain('system_pattern');
  });

  it('persists reviewer follow-ups as a strategy on approve (INT-1613)', async () => {
    await recordTaskOutcome('/tmp/repo', {
      taskTitle: 'Add login',
      workerResult: { filesChanged: ['auth.ts'], commands: [], summary: 'done' },
      reviewerLearnings: ['[docs-update] update README (README.md:10)', 'add a rate-limit test'],
    });
    const strategy = saveMemory.mock.calls.find((c) => c[0] === 'strategy');
    expect(strategy).toBeDefined();
    expect(strategy?.[3]).toContain('update README');
    expect(strategy?.[3]).toContain('rate-limit test');
  });

  it('skips the strategy memory when there are no reviewer learnings', async () => {
    await recordTaskOutcome('/tmp/repo', {
      taskTitle: 'Add login',
      workerResult: { filesChanged: ['auth.ts'], commands: [], summary: 'done' },
      reviewerLearnings: [],
    });
    expect(saveMemory.mock.calls.some((c) => c[0] === 'strategy')).toBe(false);
  });
});
