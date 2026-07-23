import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRecentConversations, logWork, searchMemorySafe } = vi.hoisted(() => ({
  getRecentConversations: vi.fn(),
  logWork: vi.fn(),
  searchMemorySafe: vi.fn(),
}));
vi.mock('../memory/index.js', () => ({ getRecentConversations, logWork, searchMemorySafe }));

import {
  formatChatMemoryContext,
  getRecentChatHistory,
  saveChatMessage,
  searchChatHistory,
} from './chatMemory.js';

/** Minimal MemorySearchResult shape — only the fields chatMemory actually reads. */
function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    content: '[discord/chan-1] alice: hello',
    derivedFrom: 'chan-1',
    createdAt: Date.UTC(2026, 6, 23, 4, 5),
    metadata: {},
    ...overrides,
  } as never;
}

describe('chatMemory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getRecentConversations.mockReset();
    logWork.mockReset();
    searchMemorySafe.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('saveChatMessage', () => {
    it('tags the stored content with source, channel, and speaker, and keys it by channel', async () => {
      logWork.mockResolvedValue('mem-1');

      await expect(saveChatMessage('discord', 'chan-1', 'user', 'hello', { username: 'alice' }))
        .resolves.toBe('mem-1');

      // channelId doubles as derivedFrom so searches can filter by conversation.
      expect(logWork).toHaveBeenCalledWith(
        'chat', 'discord chat message', '[discord/chan-1] alice: hello', undefined, 'chan-1',
      );
    });

    it('labels agent messages as OpenSwarm and unnamed users as User', async () => {
      logWork.mockResolvedValue('mem-2');

      await saveChatMessage('dashboard', 'chan-2', 'agent', 'done');
      expect(logWork.mock.calls[0][2]).toBe('[dashboard/chan-2] OpenSwarm: done');

      await saveChatMessage('dashboard', 'chan-2', 'user', 'hi');
      expect(logWork.mock.calls[1][2]).toBe('[dashboard/chan-2] User: hi');
    });

    it('returns null instead of throwing when the memory write fails', async () => {
      logWork.mockRejectedValue(new Error('lance is busy'));

      await expect(saveChatMessage('discord', 'chan-1', 'user', 'hello')).resolves.toBeNull();
    });
  });

  describe('searchChatHistory', () => {
    it('searches journal memories with the documented defaults', async () => {
      searchMemorySafe.mockResolvedValue({ success: true, memories: [] });

      await searchChatHistory('deploy');

      expect(searchMemorySafe).toHaveBeenCalledWith('deploy', {
        types: ['journal'], limit: 10, minSimilarity: 0.4, minTrust: 0.3,
      });
    });

    it('passes through caller limits and similarity', async () => {
      searchMemorySafe.mockResolvedValue({ success: true, memories: [] });

      await searchChatHistory('deploy', { limit: 3, minSimilarity: 0.9 });

      expect(searchMemorySafe.mock.calls[0][1]).toMatchObject({ limit: 3, minSimilarity: 0.9 });
    });

    it('returns an empty list when the search itself fails', async () => {
      searchMemorySafe.mockResolvedValue({ success: false, error: 'index missing' });

      await expect(searchChatHistory('deploy')).resolves.toEqual([]);
    });

    it('keeps only the requested channel, matching either derivedFrom or issueRef', async () => {
      searchMemorySafe.mockResolvedValue({
        success: true,
        memories: [
          hit({ id: 'by-derived', derivedFrom: 'chan-1' }),
          hit({ id: 'by-issue-ref', derivedFrom: 'other', metadata: { issueRef: 'chan-1' } }),
          hit({ id: 'unrelated', derivedFrom: 'chan-9', metadata: {} }),
        ],
      });

      const found = await searchChatHistory('deploy', { channelId: 'chan-1' });

      expect(found.map(m => m.id)).toEqual(['by-derived', 'by-issue-ref']);
    });

    it('keeps only the requested source by reading the content prefix', async () => {
      searchMemorySafe.mockResolvedValue({
        success: true,
        memories: [
          hit({ id: 'discord', content: '[discord/chan-1] alice: hello' }),
          hit({ id: 'dashboard', content: '[dashboard/chan-1] alice: hello' }),
        ],
      });

      const found = await searchChatHistory('hello', { source: 'dashboard' });

      expect(found.map(m => m.id)).toEqual(['dashboard']);
    });
  });

  describe('getRecentChatHistory', () => {
    it('uses chronological storage retrieval instead of semantic search', async () => {
      const rows = [{ id: 'newest', createdAt: 3 }, { id: 'older', createdAt: 2 }];
      getRecentConversations.mockResolvedValue(rows);

      await expect(getRecentChatHistory('channel-1', 2)).resolves.toBe(rows);
      expect(getRecentConversations).toHaveBeenCalledWith('channel-1', 2);
    });

    it('defaults to 20 and never asks storage for a negative or fractional count', async () => {
      getRecentConversations.mockResolvedValue([]);

      await getRecentChatHistory('channel-1');
      expect(getRecentConversations).toHaveBeenCalledWith('channel-1', 20);

      await getRecentChatHistory('channel-1', -5);
      expect(getRecentConversations).toHaveBeenLastCalledWith('channel-1', 0);

      await getRecentChatHistory('channel-1', 7.9);
      expect(getRecentConversations).toHaveBeenLastCalledWith('channel-1', 7);
    });
  });

  describe('formatChatMemoryContext', () => {
    it('renders nothing for an empty result set', () => {
      expect(formatChatMemoryContext([])).toBe('');
    });

    it('strips the source/channel prefix and keeps one line per message', () => {
      const out = formatChatMemoryContext([
        hit({ content: '[discord/chan-1] alice: first' }),
        hit({ content: '[dashboard/chan-1] OpenSwarm: second' }),
      ]);

      expect(out.startsWith('## Relevant Chat History\n')).toBe(true);
      expect(out).toContain('alice: first');
      expect(out).toContain('OpenSwarm: second');
      expect(out).not.toContain('[discord/chan-1]');
      expect(out.split('\n')).toHaveLength(3);
    });

    it('falls back to the raw content when there is no prefix to strip', () => {
      expect(formatChatMemoryContext([hit({ content: 'no prefix here' })])).toContain('no prefix here');
    });
  });
});
