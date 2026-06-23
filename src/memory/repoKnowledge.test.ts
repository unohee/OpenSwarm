import { describe, it, expect, vi } from 'vitest';

// Stub the memory core so searchRepoMemoryText is tested without LanceDB / embeddings.
// Branch on the query string to exercise each path.
vi.mock('./memoryCore.js', () => ({
  saveMemory: async () => {},
  searchMemorySafe: async (query: string) => {
    if (query === 'fail') return { success: false, memories: [], errorCode: 'DB_INIT_FAILED' };
    if (query === 'empty') return { success: true, memories: [] };
    return {
      success: true,
      memories: [{ type: 'system_pattern', title: 'Solved: add logout', content: 'wired it into the header' }],
    };
  },
}));

import { searchRepoMemoryText, repoKey } from './repoKnowledge.js';

describe('repoKey', () => {
  it('normalizes a per-issue worktree path back to the repo', () => {
    expect(repoKey('/Users/x/dev/vega-agent/worktree/abc-123')).toBe('/Users/x/dev/vega-agent');
  });
  it('leaves a plain repo path unchanged', () => {
    expect(repoKey('/Users/x/dev/vega-agent')).toBe('/Users/x/dev/vega-agent');
  });
  it('strips a worktree path with a trailing slash too', () => {
    expect(repoKey('/Users/x/dev/vega-agent/worktree/id/')).toBe('/Users/x/dev/vega-agent');
  });
});

describe('searchRepoMemoryText', () => {
  it('requires a non-empty query', async () => {
    expect(await searchRepoMemoryText('/repo', '   ')).toContain('non-empty query');
  });

  it('reports gracefully when memory is unavailable', async () => {
    const text = await searchRepoMemoryText('/repo', 'fail');
    expect(text).toContain('Memory unavailable');
    expect(text).toContain('DB_INIT_FAILED');
  });

  it('returns a friendly note when nothing matches', async () => {
    expect(await searchRepoMemoryText('/repo', 'empty')).toContain('No matching repo knowledge yet');
  });

  it('formats hits with type tags and a count', async () => {
    const text = await searchRepoMemoryText('/repo', 'logout');
    expect(text).toContain('Repository knowledge (1):');
    expect(text).toContain('[system_pattern] Solved: add logout');
    expect(text).toContain('wired it into the header');
  });
});
