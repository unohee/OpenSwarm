import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file targets the paths left uncovered by repoKnowledge.test.ts:
// - recallRepoKnowledge (success mapping/truncation, empty result, thrown error)
// - recordTaskOutcome success branch (no files / files / summary / iterations)
// - recordAuditFindings (empty actions, decision-based importance, truncation, thrown error)
// It is a separate file (not touching repoKnowledge.test.ts) per the task instructions.
const mocks = vi.hoisted(() => ({
  saveMemory: vi.fn(async () => 'memory-id'),
  searchMemorySafe: vi.fn(),
}));

// Mock the memory core exactly like repoKnowledge.test.ts does, so this file
// never touches LanceDB / real embeddings.
vi.mock('./memoryCore.js', () => ({
  saveMemory: mocks.saveMemory,
  searchMemorySafe: mocks.searchMemorySafe,
}));

import { recallRepoKnowledge, recordTaskOutcome, recordAuditFindings, repoKey, searchRepoMemoryText } from './repoKnowledge.js';
import type { RecommendedAction } from '../agents/agentPair.js';

beforeEach(() => {
  mocks.saveMemory.mockClear();
  mocks.searchMemorySafe.mockReset();
});

describe('recallRepoKnowledge', () => {
  it('scopes the search to the repo derived from the project path (repo-scoping boundary)', async () => {
    mocks.searchMemorySafe.mockResolvedValue({ success: true, memories: [] });

    await recallRepoKnowledge('/Users/x/dev/vega-agent/worktree/issue-42', 'add logout', 'wire it up');

    expect(mocks.searchMemorySafe).toHaveBeenCalledTimes(1);
    const [, options] = mocks.searchMemorySafe.mock.calls[0];
    // The worktree path must be normalized back to the repo key — a bare
    // per-worktree key would silently scope knowledge outside the repo
    // (the memoryCore pitfall this module already guards against, INT-1856).
    expect(options.repo).toBe(repoKey('/Users/x/dev/vega-agent/worktree/issue-42'));
    expect(options.repo).toBe('/Users/x/dev/vega-agent');
  });

  it('maps successful hits into RepoMemoryBrief and truncates long content', async () => {
    const longContent = 'x'.repeat(500);
    mocks.searchMemorySafe.mockResolvedValue({
      success: true,
      memories: [
        { type: 'constraint', title: 'Do not touch the migration lock', content: longContent },
        { type: 'fact', title: 'Uses pnpm workspaces', content: 'short content' },
      ],
    });

    const briefs = await recallRepoKnowledge('/repo', 'task title', 'task description');

    expect(briefs).toHaveLength(2);
    expect(briefs[0].type).toBe('constraint');
    expect(briefs[0].title).toBe('Do not touch the migration lock');
    expect(briefs[0].content.length).toBe(401); // 400 chars + ellipsis
    expect(briefs[0].content.endsWith('…')).toBe(true);
    expect(briefs[1].content).toBe('short content'); // unchanged when under the cap
  });

  it('returns an empty array when the search reports failure', async () => {
    mocks.searchMemorySafe.mockResolvedValue({ success: false, memories: [], errorCode: 'DB_INIT_FAILED' });

    const briefs = await recallRepoKnowledge('/repo', 'title', 'desc');

    expect(briefs).toEqual([]);
  });

  it('never throws — returns an empty array when the underlying search rejects', async () => {
    mocks.searchMemorySafe.mockRejectedValue(new Error('lancedb unreachable'));

    const briefs = await recallRepoKnowledge('/repo', 'title', 'desc');

    expect(briefs).toEqual([]);
  });
});

describe('searchRepoMemoryText — nullish-coalescing edge cases', () => {
  it('treats an undefined query the same as empty (query ?? "" fallback)', async () => {
    // Cast to bypass the string type — callers such as the MCP tool boundary
    // may forward an actually-undefined value at runtime.
    const text = await searchRepoMemoryText('/repo', undefined as unknown as string);

    expect(text).toBe('A non-empty query is required.');
    expect(mocks.searchMemorySafe).not.toHaveBeenCalled();
  });

  it('falls back to "unknown" when a failed search omits errorCode', async () => {
    mocks.searchMemorySafe.mockResolvedValue({ success: false, memories: [] });

    const text = await searchRepoMemoryText('/repo', 'some query');

    expect(text).toContain('Memory unavailable (unknown)');
  });
});

describe('recordTaskOutcome — success path', () => {
  it('does nothing when the worker changed no files', async () => {
    await recordTaskOutcome('/repo', {
      taskTitle: 'investigate flaky test',
      workerResult: { filesChanged: [], commands: [], summary: 'looked around, changed nothing' },
    });

    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });

  it('does nothing when workerResult is absent entirely', async () => {
    await recordTaskOutcome('/repo', { taskTitle: 'no-op task' });

    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });

  it('stores a system_pattern memory scoped to the repo when files changed, without summary/iterations', async () => {
    await recordTaskOutcome('/Users/x/dev/vega-agent/worktree/issue-7', {
      taskTitle: 'wire logout button',
      derivedFrom: 'INT-9',
      workerResult: { filesChanged: ['src/a.ts', 'src/b.ts'], commands: [], summary: '' },
    });

    expect(mocks.saveMemory).toHaveBeenCalledTimes(1);
    const [type, repo, title, content, options] = mocks.saveMemory.mock.calls[0];
    expect(type).toBe('system_pattern');
    // Repo-scoping boundary: the worktree suffix must be stripped before storage.
    expect(repo).toBe('/Users/x/dev/vega-agent');
    expect(title).toBe('Solved: wire logout button');
    expect(content).toContain('Files changed: src/a.ts, src/b.ts');
    expect(content).not.toContain('Approach:');
    expect(content).not.toContain('iterations');
    expect(options).toMatchObject({
      derivedFrom: 'INT-9',
      importance: 0.74, // no multi-iteration bump
      metadata: { kind: 'task_success', iterations: 1 },
    });
  });

  it('includes the approach summary and lists +N more for over 10 changed files', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);

    await recordTaskOutcome('/repo', {
      taskTitle: 'big refactor',
      workerResult: { filesChanged: files, commands: [], summary: 'split the monolith into modules' },
    });

    const [, , , content] = mocks.saveMemory.mock.calls[0];
    expect(content).toContain('Approach: split the monolith into modules');
    expect(content).toContain('(+2 more)');
  });

  it('bumps importance and records the iteration count when it took more than one pass', async () => {
    await recordTaskOutcome('/repo', {
      taskTitle: 'flaky fix',
      workerResult: { filesChanged: ['src/c.ts'], commands: [], summary: 'retried until it passed' },
      iterations: 3,
    });

    const [, , , content, options] = mocks.saveMemory.mock.calls[0];
    expect(content).toContain('Took 3 iterations before passing review.');
    expect(options).toMatchObject({
      importance: 0.78,
      metadata: { iterations: 3 },
    });
  });

  it('swallows storage failures without throwing (non-critical write)', async () => {
    mocks.saveMemory.mockRejectedValueOnce(new Error('lancedb write failed'));

    await expect(
      recordTaskOutcome('/repo', {
        taskTitle: 'anything',
        workerResult: { filesChanged: ['src/d.ts'], commands: [], summary: '' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordAuditFindings', () => {
  const baseActions: RecommendedAction[] = [
    { type: 'bug', title: 'Null check missing', location: 'src/x.ts:12' },
    { type: 'cleanup', title: 'Dead branch' },
  ];

  it('does nothing when there are no recommended actions', async () => {
    await recordAuditFindings('/repo', { decision: 'approve', recommendedActions: [] });

    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });

  it('stores a constraint scoped to the repo with the given decision and stamp', async () => {
    await recordAuditFindings(
      '/Users/x/dev/vega-agent/worktree/issue-3',
      { decision: 'reject', recommendedActions: baseActions },
      '2026-07-01',
    );

    expect(mocks.saveMemory).toHaveBeenCalledTimes(1);
    const [type, repo, title, body, options] = mocks.saveMemory.mock.calls[0];
    expect(type).toBe('constraint');
    // Repo-scoping boundary again: audit findings must land under the repo key, not the worktree.
    expect(repo).toBe('/Users/x/dev/vega-agent');
    expect(title).toBe('Audit findings (2026-07-01)');
    expect(body).toContain('REJECT (2026-07-01)');
    expect(body).toContain('- [bug] Null check missing (src/x.ts:12)');
    expect(body).toContain('- [cleanup] Dead branch');
    expect(options).toMatchObject({
      derivedFrom: 'cli:review-max',
      importance: 0.9, // reject -> highest importance
      metadata: { kind: 'audit_findings', decision: 'reject', actionCount: 2 },
    });
  });

  it('assigns mid-tier importance for a revise decision', async () => {
    await recordAuditFindings('/repo', { decision: 'revise', recommendedActions: baseActions }, '2026-07-02');

    const [, , , , options] = mocks.saveMemory.mock.calls[0];
    expect(options).toMatchObject({ importance: 0.84 });
  });

  it('assigns the low-tier importance for any other decision (e.g. approve)', async () => {
    await recordAuditFindings('/repo', { decision: 'approve', recommendedActions: baseActions }, '2026-07-03');

    const [, , , , options] = mocks.saveMemory.mock.calls[0];
    expect(options).toMatchObject({ importance: 0.68 });
  });

  it('caps the stored actions at 10 and notes how many more were found', async () => {
    const many: RecommendedAction[] = Array.from({ length: 15 }, (_, i) => ({
      type: 'finding',
      title: `Issue ${i}`,
    }));

    await recordAuditFindings('/repo', { decision: 'approve', recommendedActions: many }, '2026-07-04');

    const [, , , body, options] = mocks.saveMemory.mock.calls[0];
    expect(body).toContain('(+5 more — see the audit report)');
    expect(options.metadata.topActions).toHaveLength(10);
  });

  it('defaults the stamp to today when none is provided', async () => {
    const today = new Date().toISOString().slice(0, 10);

    await recordAuditFindings('/repo', { decision: 'approve', recommendedActions: baseActions });

    const [, , title] = mocks.saveMemory.mock.calls[0];
    expect(title).toBe(`Audit findings (${today})`);
  });

  it('swallows storage failures without throwing (non-critical write)', async () => {
    mocks.saveMemory.mockRejectedValueOnce(new Error('lancedb write failed'));

    await expect(
      recordAuditFindings('/repo', { decision: 'approve', recommendedActions: baseActions }),
    ).resolves.toBeUndefined();
  });
});
